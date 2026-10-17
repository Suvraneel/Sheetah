import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/**
 * Last line of defence: if rendering crashes, show what happened and a way out instead of a blank
 * page. "Copy details" gives version, browser and the error (never any data) for a bug report.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Sheetah crashed', error, info.componentStack)
  }

  details() {
    const e = this.state.error
    return [`Sheetah ${__APP_VERSION__}`, navigator.userAgent, `${e?.name}: ${e?.message}`, e?.stack?.split('\n').slice(1, 6).join('\n') ?? ''].join('\n')
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>
          Sheetah hit an unexpected error. Your files were never uploaded, so nothing left this computer. Reloading starts
          fresh; tables you chose to keep in this browser come back.
        </p>
        <pre className="crash-detail">{this.state.error.message}</pre>
        <div className="crash-actions">
          <button className="btn btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
          <button className="btn btn-ghost" onClick={() => void navigator.clipboard?.writeText(this.details()).catch(() => {})}>
            Copy details
          </button>
          <a className="btn btn-ghost" href="https://github.com/Suvraneel/Sheetah/issues/new" target="_blank" rel="noreferrer">
            Report it
          </a>
        </div>
      </main>
    )
  }
}
