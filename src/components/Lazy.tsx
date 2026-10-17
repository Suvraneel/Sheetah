import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  /** The part couldn't load or crashed: close it and say so (the rest of the app carries on). */
  onFail: (error: Error) => void
}

/**
 * A part of the app that loads on first use (a dialog, the column menu, the chart view): shown when its
 * code arrives, and if that fails (offline after a new version went out) or the part itself crashes,
 * it's closed with a message instead of taking the whole page, and the open tables, down with it.
 */
export class Lazy extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('Sheetah: a part failed', error, info.componentStack)
    this.props.onFail(error)
  }

  render() {
    return this.state.failed ? null : <Suspense fallback={this.props.fallback ?? null}>{this.props.children}</Suspense>
  }
}
