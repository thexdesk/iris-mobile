import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Storage } from '@ionic/storage';
import { InAppBrowser } from '@ionic-native/in-app-browser';
import { Subject, Observable } from 'rxjs';
import { IrisInfoProvider } from '../iris_info/iris_info';

export class Incident {
  active: boolean;
  application: string;
  context: any;
  created: number;
  current_step: number;
  id: number;
  owner: string;
  plan: string;
  plan_id: number;
  updated: number;
  title: string;
}

export class GraphData {
  current: string;
  original: string;
}

export class IncidentFilters {
  active: boolean;
  inactive: boolean;
  queryParams: Map<string,string>;

  public clone() {
    let newFilters = new IncidentFilters();
    newFilters.active = this.active;
    newFilters.inactive = this.inactive;
    newFilters.queryParams = new Map(this.queryParams);
    return newFilters;
  }
}

class TokenResponse {
  token: string;
  key_id: string;
  expiry: number;
}

/*
  The Iris provider handles interface with Iris, renewing tokens as needed.
  This provider offers methods for getting incidents, app templates, and
  graph data.
*/
@Injectable()
export class IrisProvider {
  dummyRedirect: string = 'http://localhost:7000';
  apiPath: string = '/api/v0/mobile';
  tokenLeeway: number = 600;
  incidents: Map<number, Incident>;

  constructor(public http: HttpClient, private storage: Storage, private irisInfo: IrisInfoProvider,
    private iab: InAppBrowser) {
      this.incidents = new Map();
    }

  // Ensures valid refresh token, then renews access key
  public renewAccessKey() : Observable<void> {
    const renewKey = () => {
      // Ensure refresh token is valid and fire a refresh request
      this.renewRefreshKey()
      .flatMap(() => this.http.get<TokenResponse>(`${this.irisInfo.baseUrl}${this.apiPath}/refresh`))
      .flatMap(data => {
        // Wait for storage to set all keys before returning
        return Observable.fromPromise(Promise.all([this.storage.set('accessKey', data.token),
        this.storage.set('accessKeyId', data.key_id),
        this.storage.set('accessExpiry', data.expiry)]))
      }).subscribe(
        () => accessSubject.next(),
        () => accessSubject.error('Failed to renew key')
      )
    }

    let accessSubject = new Subject<void>();
    this.storage.ready()
    .then(() => this.storage.get('accessExpiry'))
    .then(expiry => {
      // Check if access token has expired and renew if needed
      if (!expiry || expiry < Date.now() / 1000 + this.tokenLeeway){
        renewKey();
      }
      else {
        // If access token is still valid, signal to observable
        accessSubject.next();
      }
    })
    return accessSubject.asObservable();
  }

  // Ensures refresh key is valid. If expired, open login page for re-auth
  public renewRefreshKey(loggedOut = false) : Observable<void>{
    let refreshSubject = new Subject<void>();

    const handleRedirect = (browser, event) => {
      // Check URL for dummy redirect
      if ((event.url).indexOf(this.dummyRedirect) === 0) {
        let responseParameters = ((event.url).split("#")[1]).split("&"),
        parsedResponse = {};

        // Parse response url
        for (let i = 0; i < responseParameters.length; i++) {
          parsedResponse[responseParameters[i].split("=")[0]] = responseParameters[i].split("=")[1];
        }

        // Validate response
        if (parsedResponse.hasOwnProperty('token') && parsedResponse.hasOwnProperty('keyId')
        && parsedResponse.hasOwnProperty('expiry') && parsedResponse.hasOwnProperty('username')) {
          // Set refresh params and broadcast to refresh observable
          Promise.all([this.storage.set('refreshKey', parsedResponse['token']),
          this.storage.set('refreshKeyId', parsedResponse['keyId']),
          this.storage.set('refreshExpiry', parsedResponse['expiry']),
          this.irisInfo.setUsername(parsedResponse['username'])]).then(() => {
            refreshSubject.next();
          });
        } else {
          refreshSubject.error('Invalid token refresh response from API');
        }
        browser.close();
      }
    }

    // Check if refresh token has expired
    this.storage.ready()
    .then(() =>this.storage.get('refreshExpiry'))
    .then((expiry) => {
      let loginUrl = this.irisInfo.loginUrl;
      if (!expiry || expiry < Date.now() / 1000 + this.tokenLeeway){
        // If expired, open in-app browser to login to SSO
        let browserOptions = 'location=no';
        if (loggedOut) {
          browserOptions += ',clearcache=yes'
        }
        let browser = this.iab.create(loginUrl, '_blank', browserOptions);
        // Intercept redirect to populate refresh token params
        browser.on('loadstart').subscribe(
          (event) => {
            handleRedirect(browser, event);
          },
          () => {refreshSubject.error('Failed to open login page')}
        );
        browser.on('exit').subscribe(
          () => {
            this.storage.get('refreshExpiry')
            .then((expiry) => {
              // If refresh token hasn't been refreshed, error out
              if (!expiry || expiry < Date.now() / 1000 + this.tokenLeeway) {
                refreshSubject.error('Login window closed');
              }
            })
          }
        )
      } else {
        refreshSubject.next();
      }
    })
    return refreshSubject.asObservable();
  }

  public clearIncidents() {
    this.incidents.clear();
  }

  // Get incident info from filters specified.
  public getIncidents(filters: IncidentFilters) : Observable<Incident[]> {
    let params = {},
    startObservable = this.renewAccessKey();

    // Set up incident call params based on filters
    filters.queryParams.forEach((value, key) => params[key] = value)

    if (!filters.active) {
      params['active'] = '0';
    } else if (!filters.inactive) {
      params['active'] = '1';
    }

    // Get incidents according to params
    var returnObservable = startObservable
      .flatMap(() => this.http.get<Incident[]>(`${this.irisInfo.baseUrl}${this.apiPath}/incidents`, { params: new HttpParams({fromObject: params}) }));

    return returnObservable
      .do(incidents => {
        for (let i of incidents) {
          // TODO: consider removing
          i.title = i.title ? i.title : i.context['name'];
          this.incidents.set(i.id, i);
        }
      });
  }

  public getIncident(incidentId: number) {
    if (this.incidents.has(incidentId)) {
      return Observable.of(this.incidents.get(incidentId));
    }
    return this.renewAccessKey()
      .flatMap(() => this.http.get<Incident>(`${this.irisInfo.baseUrl}${this.apiPath}/incidents/${incidentId}`))
      .do((incident) => {
        // TODO: consider removing
        incident.title = incident.title ? incident.title : incident.context['name'];
        this.incidents.set(incident.id, incident);
      });
  }

  // Claim incidents with specified ids
  public claim(incidents: Array<Incident>) {
    if (incidents.length == 0) {
      return Observable.of(null);
    }
    let incidentIds = incidents.map(x => x.id);
    return this.renewAccessKey()
      .flatMap(() => this.http.post(`${this.irisInfo.baseUrl}${this.apiPath}/incidents/claim`, {'incident_ids':incidentIds, 'owner': this.irisInfo.username}))
      .do(() => incidents.forEach((i) => {i.active = false; i.owner = this.irisInfo.username}))
  }

  public claimById(incidentId) {
    return this.renewAccessKey()
      .flatMap(() => this.http.post(`${this.irisInfo.baseUrl}${this.apiPath}/incidents/${incidentId}`, {'owner': this.irisInfo.username}))
  }

  // Get mobile template for a given app
  public getTemplate(app: string) {
    return this.renewAccessKey()
      .flatMap(() => this.http.get(`${this.irisInfo.baseUrl}${this.apiPath}/applications/${app}`))
  }

  // Get current/original graphs given a source
  public getGraph(source) {
    const options = { params: new HttpParams().set('graph_url', source)}
    return this.renewAccessKey().flatMap(() => this.http.get(`${this.irisInfo.baseUrl}${this.apiPath}/graph`, options))
  }

  public register(regId: string, platform: string) {
    return this.renewAccessKey().flatMap(
      () => this.http.post(`${this.irisInfo.baseUrl}${this.apiPath}/device`, {'registration_id': regId, 'platform': platform}))
  }

  public debug() {
    let dummy = () => Observable.create(observer => observer.next());
    this.renewAccessKey = dummy;
    this.renewRefreshKey = dummy;
  }
}
