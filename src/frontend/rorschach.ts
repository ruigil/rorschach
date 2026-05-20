import './components/index.js'
import './corona.js'
import './markdown.js'
import { initRouter } from './router.js'

initRouter();

// The application is now bootstrapped by the <r-shell> component.
// It handles authentication fetching, session initialization, 
// and WebSocket connection management.
