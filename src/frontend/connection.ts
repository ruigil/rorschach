// Public entrypoint — delegates to the connection service so callers that
// import `connect` from `../connection.js` (e.g. r-shell) keep working.
export { connect, send, disconnect, isConnected } from './shell/connection-service.js'
