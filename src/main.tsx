import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/plus-jakarta-sans'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { recoverFromStaleChunks, registerServiceWorker } from './sw-client'

// Offline support: production only (the dev server's HMR and a service worker don't mix).
registerServiceWorker()
recoverFromStaleChunks()

// compat.js has already explained why this browser can't run Sheetah: leave its message in place.
if (!(window as { __sheetahUnsupported?: string }).__sheetahUnsupported) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}
