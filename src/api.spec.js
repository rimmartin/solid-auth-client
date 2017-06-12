/* eslint-env mocha */
/* global expect */
import fs from 'fs'
import jwt from 'jsonwebtoken'
import nock from 'nock'
import rsaPemToJwk from 'rsa-pem-to-jwk'
import URLSearchParams from 'url-search-params'

import { currentSession, login, logout } from './api'
import { getSession, saveSession } from './session'
import { memStorage } from './storage'

/*
 * OIDC test data:
 *   1) the oidc configuration returned from '/.well-known/openid-configuration'
 *   2) the registration response
 *   3) the json web key set
 */

const oidcConfiguration = {
  issuer: 'https://localhost',
  jwks_uri: 'https://localhost/jwks',
  registration_endpoint: 'https://localhost/register',
  authorization_endpoint: 'https://localhost/authorize',
  end_session_endpoint: 'https://localhost/logout'
}

const oidcRegistration = {
  client_id: 'the-client-id'
}

const pem = fs.readFileSync('./test-keys/id_rsa')

const jwks = {
  keys: [
    rsaPemToJwk(
      // the PEM-encoded key
      pem,
      // extra data for the JWK
      { kid: '1', alg: 'RS256', use: 'sig', key_ops: [ 'verify' ] },
      // serialize just the public key
      'public'
    )
  ]
}

let _href
let _URL

// polyfill missing/incomplete web apis
beforeEach(() => {
  _href = window.location.href
  Object.defineProperty(window.location, 'href', {
    writable: true,
    value: 'https://app.biz/'
  })
  Object.defineProperty(window.location, 'origin', {
    writable: true,
    value: 'https://app.biz'
  })
  Object.defineProperty(window.location, 'pathname', {
    writable: true,
    value: '/'
  })
  _URL = window.URL
  window.URL = function (urlStr) {
    const url = new _URL(urlStr)
    url.searchParams = new URLSearchParams(url.search)
    return url
  }
  window.URLSearchParams = URLSearchParams
  window.localStorage = memStorage()
})

afterEach(() => {
  delete window.localStorage
  delete window.URLSearchParams
  window.URL = _URL
  window.location.href = _href
})

describe('login', () => {
  beforeEach(() => {
    nock.disableNetConnect()
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  describe('WebID-TLS', () => {
    it('can log in with WebID-TLS', () => {
      const webId = 'https://localhost/profile#me'
      nock('https://localhost/')
        .options('/')
        .reply(200, '', { user: webId })

      return login('https://localhost')
        .then(({ session }) => {
          expect(session.webId).toBe(webId)
          expect(getSession(window.localStorage, 'https://localhost')).toEqual(session)
        })
    })
  })

  describe('WebID-OIDC', () => {
    it('can log in with WebID-OIDC', () => {
      nock('https://localhost/')
        // try to log in with WebID-TLS
        .options('/')
        .reply(200)
        // no user header, so try to use WebID-OIDC
        .get('/.well-known/openid-configuration')
        .reply(200, oidcConfiguration)
        .get('/jwks')
        .reply(200, jwks)
        .post('/register')
        .reply(200, oidcRegistration)

      return login('https://localhost')
        .then(() => {
          const location = new window.URL(window.location.href)
          expect(location.origin).toEqual('https://localhost')
          expect(location.pathname).toEqual('/authorize')
          expect(location.searchParams.get('redirect_uri')).toEqual('https://app.biz/')
          expect(location.searchParams.get('response_type')).toEqual('id_token token')
          expect(location.searchParams.get('scope')).toEqual('openid')
          expect(location.searchParams.get('client_id')).toEqual('the-client-id')
        })
    })

    it('uses the provided redirect uri', () => {
      nock('https://localhost')
        // try to log in with WebID-TLS
        .options('/')
        .reply(200)
        // no user header, so try to use WebID-OIDC
        .get('/.well-known/openid-configuration')
        .reply(200, oidcConfiguration)
        .get('/jwks')
        .reply(200, jwks)
        .post('/register')
        .reply(200, oidcRegistration)

      return login('https://localhost', { redirectUri: 'https://app.biz/welcome/' })
        .then(() => {
          const location = new window.URL(window.location.href)
          expect(location.origin).toEqual('https://localhost')
          expect(location.pathname).toEqual('/authorize')
          expect(location.searchParams.get('redirect_uri')).toEqual('https://app.biz/welcome/')
          expect(location.searchParams.get('response_type')).toEqual('id_token token')
          expect(location.searchParams.get('scope')).toEqual('openid')
          expect(location.searchParams.get('client_id')).toEqual('the-client-id')
        })
    })

    it('strips the hash fragment from the current URL when proiding the default redirect URL', () => {
      nock('https://localhost/')
        // try to log in with WebID-TLS
        .options('/')
        .reply(200)
        // no user header, so try to use WebID-OIDC
        .get('/.well-known/openid-configuration')
        .reply(200, oidcConfiguration)
        .get('/jwks')
        .reply(200, jwks)
        .post('/register')
        .reply(200, oidcRegistration)

      window.location.href += '#foo-bar'

      return login('https://localhost')
        .then(() => {
          const location = new window.URL(window.location.href)
          expect(location.origin).toEqual('https://localhost')
          expect(location.pathname).toEqual('/authorize')
          expect(location.searchParams.get('redirect_uri')).toEqual('https://app.biz/')
          expect(location.searchParams.get('response_type')).toEqual('id_token token')
          expect(location.searchParams.get('scope')).toEqual('openid')
          expect(location.searchParams.get('client_id')).toEqual('the-client-id')
        })
    })

    // TODO: this is broken due to https://github.com/anvilresearch/oidc-rp/issues/26
    it('resolves to a `null` session when none of the recognized auth schemes are available')
  })
})

describe('currentSession', () => {
  it('can find the current user if stored', () => {
    saveSession(window.localStorage, {
      idp: 'https://localhost',
      webId: 'https://person.me/#me',
      accessToken: 'fake_access_token',
      idToken: 'abc.def.ghi'
    })

    return currentSession()
      .then(({ session }) => {
        expect(session.webId).toBe('https://person.me/#me')
        expect(getSession(window.localStorage, 'https://localhost')).toEqual(session)
      })
  })

  it('resolves to a `null` session when there is no stored user session', () => {
    return currentSession()
      .then(({ session }) => {
        expect(session).toBeNull()
        expect(getSession(window.localStorage)).toBeNull()
      })
  })

  describe('WebID-OIDC', () => {
    it('can find the current user from the URL auth response', () => {
      // To test currentSession with WebID-OIDC it's easist to set up the OIDC RP
      // client by logging in, generating the IDP's response, and redirecting
      // back to the app.
      nock('https://localhost/')
        // try to log in with WebID-TLS
        .options('/')
        .reply(200)
        // no user header, so try to use WebID-OIDC
        .get('/.well-known/openid-configuration')
        .reply(200, oidcConfiguration)
        .get('/jwks')
        .reply(200, jwks)
        .post('/register')
        .reply(200, oidcRegistration)
        // see https://github.com/anvilresearch/oidc-rp/issues/29
        .get('/jwks')
        .reply(200, jwks)

      let expectedIdToken, expectedAccessToken

      return login('https://localhost')
        .then(() => {
          // generate the auth response
          const location = new window.URL(window.location.href)
          const state = location.searchParams.get('state')
          const redirectUri = location.searchParams.get('redirect_uri')
          const nonce = location.searchParams.get('nonce')
          const accessToken = 'example_access_token'
          const { alg } = jwks.keys[0]
          const idToken = jwt.sign(
            {
              iss: oidcConfiguration.issuer,
              aud: oidcRegistration.client_id,
              exp: Math.floor(Date.now() / 1000) + (60 * 60), // one hour
              sub: 'https://person.me/#me',
              nonce
            },
            pem,
            { algorithm: alg }
          )
          expectedIdToken = idToken
          expectedAccessToken = accessToken
          window.location.href = `${redirectUri}#` +
            `access_token=${accessToken}&` +
            `token_type=Bearer&` +
            `id_token=${idToken}&` +
            `state=${state}`
        })
        .then(currentSession)
        .then(({ session }) => {
          expect(session.webId).toBe('https://person.me/#me')
          expect(session.accessToken).toBe(expectedAccessToken)
          expect(session.idToken).toBe(expectedIdToken)
          expect(getSession(window.localStorage, 'https://localhost')).toEqual(session)
        })
    })
  })
})

describe('logout', () => {
  describe('WebID-TLS', () => {
    it('just removes the current session from the store', () => {
      saveSession(window.localStorage, {
        idp: 'https://localhost',
        webId: 'https://person.me/#me',
        accessToken: 'fake_access_token',
        idToken: 'abc.def.ghi'
      })

      return logout()
        .then(() => {
          expect(getSession(window.localStorage, 'https://localhost')).toBeNull()
        })
    })
  })

  describe('WebID-OIDC', () => {
    it('hits the end_session_endpoint and clears the current session from the store', () => {
      // To test currentSession with WebID-OIDC it's easist to set up the OIDC RP
      // client by logging in, generating the IDP's response, and redirecting
      // back to the app.
      nock('https://localhost/')
        // try to log in with WebID-TLS
        .options('/')
        .reply(200)
        // no user header, so try to use WebID-OIDC
        .get('/.well-known/openid-configuration')
        .reply(200, oidcConfiguration)
        .get('/jwks')
        .reply(200, jwks)
        .post('/register')
        .reply(200, oidcRegistration)
        // no luck, try with WebID-OIDC
        // see https://github.com/anvilresearch/oidc-rp/issues/29
        .get('/jwks')
        .reply(200, jwks)
        .get('/logout')
        .reply(200)

      let expectedIdToken, expectedAccessToken

      return login('https://localhost')
        .then(() => {
          // generate the auth response
          const location = new window.URL(window.location.href)
          const state = location.searchParams.get('state')
          const redirectUri = location.searchParams.get('redirect_uri')
          const nonce = location.searchParams.get('nonce')
          const accessToken = 'example_access_token'
          const { alg } = jwks.keys[0]
          const idToken = jwt.sign(
            {
              iss: oidcConfiguration.issuer,
              aud: oidcRegistration.client_id,
              exp: Math.floor(Date.now() / 1000) + (60 * 60), // one hour
              sub: 'https://person.me/#me',
              nonce
            },
            pem,
            { algorithm: alg }
          )
          expectedIdToken = idToken
          expectedAccessToken = accessToken
          window.location.href = `${redirectUri}#` +
            `access_token=${accessToken}&` +
            `token_type=Bearer&` +
            `id_token=${idToken}&` +
            `state=${state}`
        })
        .then(currentSession)
        .then(({ session }) => {
          expect(session.webId).toBe('https://person.me/#me')
          expect(session.accessToken).toBe(expectedAccessToken)
          expect(session.idToken).toBe(expectedIdToken)
          expect(getSession(window.localStorage, 'https://localhost')).toEqual(session)
        })
        .then(() => logout())
        .then(() => {
          expect(getSession(window.localStorage, 'https://localhost')).toBeNull()
        })
    })
  })
})

describe('fetch', () => {
  it('handles 401s from WebID-OIDC resources by resending with credentials', () => {
    saveSession(window.localStorage, {
      idp: 'https://localhost',
      webId: 'https://person.me/#me',
      accessToken: 'fake_access_token',
      idToken: 'abc.def.ghi'
    })

    nock('https://third-party.com')
      .get('/protected-resource')
      .reply(401, '', { 'www-authenticate': 'Bearer scope=openid' })
      .get('/protected-resource')
      .matchHeader('authorization', 'Bearer fake_access_token')
      .reply(200)

    return currentSession()
      .then(({ session, fetch }) => {
        expect(session.webId).toBe('https://person.me/#me')
        return fetch('https://third-party.com/protected-resource')
      })
      .then(resp => {
        expect(resp.status).toBe(200)
      })
  })

  it('does not resend with credentials if the www-authenticate header is missing', () => {
    saveSession(window.localStorage, {
      idp: 'https://localhost',
      webId: 'https://person.me/#me',
      accessToken: 'fake_access_token',
      idToken: 'abc.def.ghi'
    })

    nock('https://third-party.com')
      .get('/protected-resource')
      .reply(401)

    return currentSession()
      .then(({ session, fetch }) => {
        expect(session.webId).toBe('https://person.me/#me')
        return fetch('https://third-party.com/protected-resource')
      })
      .then(resp => {
        expect(resp.status).toBe(401)
      })
  })

  it('does not resend with credentials if the www-authenticate header suggests an unknown scheme', () => {
    saveSession(window.localStorage, {
      idp: 'https://localhost',
      webId: 'https://person.me/#me',
      accessToken: 'fake_access_token',
      idToken: 'abc.def.ghi'
    })

    nock('https://third-party.com')
      .get('/protected-resource')
      .reply(401, '', { 'www-authenticate': 'Basic token' })

    return currentSession()
      .then(({ session, fetch }) => {
        expect(session.webId).toBe('https://person.me/#me')
        return fetch('https://third-party.com/protected-resource')
      })
      .then(resp => {
        expect(resp.status).toBe(401)
      })
  })
})
