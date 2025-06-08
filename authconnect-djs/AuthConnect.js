import { FIREBASE_CONFIG, generateRandomString, POLL_EXPIRY, POLL_INTERVAL, SERVICES, WEB_REDIRECT_URL } from "./consts.js";
import {initializeApp} from "firebase/app";
import fetch from "node-fetch";
import {getFunctions, httpsCallable} from "firebase/functions";
import FirestoreDataStore from "./datastores/FirestoreDataStore.js";
import LocalFileDataStore from "./datastores/LocalFileDataStore.js";

export default class AuthConnect {
    #onDataGet;
    #onDataUpdate;
    #onLinked;
    #firebaseApp;
    #functions;
    #pollFunction;
    #serviceConstants;
    #activePolling = [
        /*
        {
            guildId: string,
            service: string,
            state: string,
            expires: Date
        }
        */
    ];

    constructor(serviceConstants) {
        this.#setPollingInterval();
        this.#firebaseApp = initializeApp(FIREBASE_CONFIG);
        this.#functions = getFunctions(this.#firebaseApp);
        this.#pollFunction = httpsCallable(this.#functions, "pollForAuthResult");
        this.#serviceConstants = serviceConstants;
    }

    #setPollingInterval() {
        // Poll every 5 seconds for new tokens from the server
        // If a token is found, update the data store
        // If the poll request is expired, pop it

        setInterval(async () => {
            for(let i = this.#activePolling.length - 1; i >= 0; i--) {
                const poll = this.#activePolling[i];
                if(poll.expires < new Date()) {
                    this.#activePolling.splice(this.#activePolling.indexOf(poll), 1);
                    continue;
                }
                // TODO: maybe change function to support batched polling? It's impractical to send a request for every poll object
                this.#pollFunction({state: poll.state}).then(res => {
                    if(!res.data.code) return;
                    
                    this.#activePolling.splice(this.#activePolling.indexOf(poll), 1);
                    this.#exchangeCode(poll.service, poll.guildId, res.data.code);
                }, (e) => {
                    console.error("Error polling for auth result");
                    console.error(e);
                })

            }
        }, POLL_INTERVAL);
    }

    async #exchangeCode(service, guildId, code) {
        const serviceData = SERVICES[service];
        if(!serviceData) throw new Error("Invalid service: " + service);
        const serviceConstantsData = this.#serviceConstants[service];
        if(!serviceConstantsData) throw new Error("No service constants found for service " + service + ". Did you forget to pass them to the constructor?");

        const result = await fetch(serviceData.tokenUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: WEB_REDIRECT_URL,
                client_id: serviceConstantsData.clientId,
                client_secret: serviceConstantsData.clientSecret
            })
        });
        const json = await result.json();
        if("error" in json){
            console.error("Error returned by authorization exchange endpoint! ");
            console.error(json);
            return;
        }
        const expiryDate = new Date();
        expiryDate.setSeconds(expiryDate.getSeconds() + json.expires_in);
        this.#onDataUpdate(service, guildId, {
            refreshToken: json.refresh_token,
            accessToken: json.access_token,
            expiryDate
        });

        if(this.#onLinked) this.#onLinked(service, guildId);
    }

    async #refreshToken(service, guildId, refreshToken) {
        const serviceData = SERVICES[service];
        if(!serviceData) throw new Error("Invalid service: " + service);
        const serviceConstantsData = this.#serviceConstants[service];
        if(!serviceConstantsData) throw new Error("No service constants found for service " + service + ". Did you forget to pass them to the constructor?");

        const result = await fetch(serviceData.tokenUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: serviceConstantsData.clientId,
                client_secret: serviceConstantsData.clientSecret
            })
        });
        const json = await result.json();
        if("error" in json){
            console.error("Error returned by refresh token endpoint!");
            console.error(json);
            return;
        }
        const expiryDate = new Date();
        expiryDate.setSeconds(expiryDate.getSeconds() + json.expires_in);
        await this.#onDataUpdate(service, guildId, {
            refreshToken,
            accessToken: json.access_token,
            expiryDate
        });
    }

    setDataHandlers(onDataGet, onDataUpdate) {
        this.#onDataGet = onDataGet;
        this.#onDataUpdate = onDataUpdate;
    }

    useDefaultDataHandlers(filePath) {
        const localFileDataStore = new LocalFileDataStore(filePath);
        localFileDataStore.initializeFile();
        this.setDataHandlers(localFileDataStore.onDataGet.bind(localFileDataStore), localFileDataStore.onDataUpdate.bind(localFileDataStore));
    }

    useFirestoreDataHandlers(firestore, collectionName) {
        const firestoreDataStore = new FirestoreDataStore(firestore, collectionName);
        this.setDataHandlers(firestoreDataStore.onDataGet.bind(firestoreDataStore), firestoreDataStore.onDataUpdate.bind(firestoreDataStore));
    }

    async isGuildLoggedIn(service, guildId) {
        if(!this.#onDataGet) throw new Error("No data handlers set. You likely forgot to call either useDefaultDataHandlers, useFirestoreDataHandlers, or setDataHandlers.");
        const data = await this.#onDataGet(service, guildId);
        if(!data || !data.refreshToken) return false;
        return true;
    }

    generateAuthURL(service, guildId, scope) {
        const serviceData = SERVICES[service];
        if(!serviceData) throw new Error("Invalid service argument.");
        const serviceConstantsData = this.#serviceConstants[service];
        if(!serviceConstantsData) throw new Error("No service constants found for service " + service + ". Did you forget to pass them to the constructor?");

        const state = generateRandomString();
        this.#activePolling.push({
            service,
            guildId,
            state,
            expires: new Date(Date.now() + POLL_EXPIRY)
        })
        
        const url = serviceData.authUrl
            .replace("{{CLIENT_ID}}", encodeURIComponent(serviceConstantsData.clientId))
            .replace("{{REDIR}}", encodeURIComponent(WEB_REDIRECT_URL))
            .replace("{{SCOPE}}", encodeURIComponent(scope))
            .replace("{{STATE}}", encodeURIComponent(state));

        return url;
    }

    async getAccessToken(service, guildId) {
        if(!this.#onDataGet) throw new Error("No data handlers set. You likely forgot to call either useDefaultDataHandlers, useFirestoreDataHandlers, or setDataHandlers.");
        let data = await this.#onDataGet(service, guildId);
        if(!data) return null;
        if(!data.accessToken || !data.expiryDate || data.expiryDate.getTime() - Date.now() <= 0) {
            if(!data.refreshToken) {
                console.error("Could not refresh token, as there is no saved refresh token.");
                return null;
            }
            await this.#refreshToken(service, guildId, data.refreshToken);
            // data is now stale, re-fetch
            data = await this.#onDataGet(service, guildId);
        }
        return data.accessToken;
    }

    async getAccessTokenExpiryDate(service, guildId) {
        if(!this.#onDataGet) throw new Error("No data handlers set. You likely forgot to call either useDefaultDataHandlers, useFirestoreDataHandlers, or setDataHandlers.");
        let data = await this.#onDataGet(service, guildId);
        if(!data) return null;
        if(!data.accessToken || !data.expiryDate) return null;
        return data.expiryDate;
    }

    async getRefreshToken(service, guildId) {
        if(!this.#onDataGet) throw new Error("No data handlers set. You likely forgot to call either useDefaultDataHandlers, useFirestoreDataHandlers, or setDataHandlers.");
        let data = await this.#onDataGet(service, guildId);
        if(!data) return null;
        if(!data.refreshToken) return null;
        return data.refreshToken;
    }

    async registerService(serviceID, service) {
        SERVICES[serviceID] = service;
    }

    setLinkedCallback(onLinked) {
        this.#onLinked = onLinked;
    }
}
