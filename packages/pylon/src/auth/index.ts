import {MiddlewareHandler} from 'hono'
import jwt from 'jsonwebtoken'
import type {IdTokenClaims, IntrospectionResponse} from 'openid-client'
import path from 'path'
import {HTTPException} from 'hono/http-exception'
import {StatusCode} from 'hono/utils/http-status'
import * as Sentry from '@sentry/bun'
import {logger} from '../logger'

const AUTH_PROJECT_ID = process.env.AUTH_PROJECT_ID

export type AuthState = IntrospectionResponse & IdTokenClaims

const authInitialize = () => {
  // Load private key file from cwd
  const authKeyFilePath = path.join(process.cwd(), 'key.json')

  const authKey = process.env.AUTH_KEY

  // Load private key file from cwd
  const API_PRIVATE_KEY_FILE: {
    type: 'application'
    keyId: string
    key: string
    appId: string
    clientId: string
  } = authKey ? JSON.parse(authKey) : require(authKeyFilePath)

  const AUTH_ISSUER = process.env.AUTH_ISSUER

  if (!AUTH_ISSUER) {
    throw new Error('AUTH_ISSUER is not set')
  }

  logger.info(`AUTH_ISSUER: ${AUTH_ISSUER}`)
  logger.info(`AUTH_PROJECT_ID: ${AUTH_PROJECT_ID}`)

  const middleware: MiddlewareHandler<{
    Variables: {
      auth: AuthState
    }
  }> = Sentry.startSpan(
    {
      name: 'AuthMiddleware',
      op: 'auth'
    },
    () =>
      async function (ctx, next) {
        const ZITADEL_INTROSPECTION_URL = `${AUTH_ISSUER}/oauth/v2/introspect`

        async function introspectToken(
          tokenString: string
        ): Promise<AuthState> {
          // Create JWT for client assertion
          const payload = {
            iss: API_PRIVATE_KEY_FILE.clientId,
            sub: API_PRIVATE_KEY_FILE.clientId,
            aud: AUTH_ISSUER,
            exp: Math.floor(Date.now() / 1000) + 60 * 60, // Expires in 1 hour
            iat: Math.floor(Date.now() / 1000)
          }

          const headers = {
            alg: 'RS256',
            kid: API_PRIVATE_KEY_FILE.keyId
          }
          const jwtToken = jwt.sign(payload, API_PRIVATE_KEY_FILE.key, {
            algorithm: 'RS256',
            header: headers
          })

          // Send introspection request
          const body = new URLSearchParams({
            client_assertion_type:
              'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: jwtToken,
            token: tokenString,
            scope:
              'openid profile email urn:zitadel:iam:org:project:id:250570845464822126:aud'
          }).toString()

          try {
            const response = await fetch(ZITADEL_INTROSPECTION_URL, {
              method: 'POST',
              headers: {'Content-Type': 'application/x-www-form-urlencoded'},
              body
            })

            if (!response.ok) {
              throw new Error('Network response was not ok')
            }

            const tokenData = await response.json()

            return tokenData as AuthState
          } catch (error) {
            console.error('Error while introspecting token', error)
            throw new Error('Token introspection failed')
          }
        }

        let token: string | undefined = undefined

        if (ctx.req.header('Authorization')) {
          const authHeader = ctx.req.header('Authorization')

          if (authHeader) {
            const parts = authHeader.split(' ')

            if (parts.length === 2 && parts[0] === 'Bearer') {
              token = parts[1]
            }
          }
        }

        if (!token) {
          const queryToken = ctx.req.query('token')

          if (queryToken) {
            token = queryToken
          }
        }

        if (token) {
          const auth = await introspectToken(token)

          ctx.set('auth', auth)

          Sentry.setUser({
            id: auth.sub,
            username: auth.preferred_username,
            email: auth.email,
            details: auth
          })
        }

        return next()
      }
  )

  return middleware
}

export type AuthRequireChecks = {
  roles?: string[]
}

const authRequire = (checks: AuthRequireChecks = {}) => {
  const middleware: MiddlewareHandler<{
    Variables: {
      auth?: AuthState
    }
  }> = async (ctx, next) => {
    // Check if user is authenticated
    const auth = ctx.get('auth')

    if (!auth) {
      throw new HTTPException(401, {
        message: 'Authentication required'
      })
    }

    if (checks.roles) {
      const roles = (auth['roles'] || []) as string[]

      const hasRole = checks.roles.some(role => {
        return (
          roles.includes(role) || roles.includes(`${AUTH_PROJECT_ID}:${role}`)
        )
      })

      if (!hasRole) {
        const resError = new Response('Forbidden', {
          status: 403,
          statusText: 'Forbidden',
          headers: {
            'Missing-Roles': checks.roles.join(','),
            'Obtained-Roles': roles.join(',')
          }
        })

        throw new HTTPException(resError.status as StatusCode, {res: resError})
      }
    }

    return next()
  }

  return middleware
}

export const auth = {
  initialize: authInitialize,
  require: authRequire
}

export {requireAuth} from './decorators/requireAuth'
