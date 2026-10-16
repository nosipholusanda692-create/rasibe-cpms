import React from 'react';

/**
 * Without this, an error while a page is drawing (a response with a field the
 * page did not expect, a bug in one screen) unmounts the whole application and
 * leaves a blank white window with no way back.
 *
 * Used twice: around each page inside the shell, keyed by the address so that
 * choosing another page clears it and the menu keeps working; and around the
 * whole application as the last resort, for a fault in the shell itself.
 *
 * It catches faults while rendering. A failed request is not one of those: the
 * screens show an ApiError's message themselves.
 */
interface Props {
  children: React.ReactNode;
  /** Centre the message on an otherwise empty page, for the outermost use. */
  fullPage?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The browser console is the only log a client has. Nothing is sent anywhere.
    console.error('[ui error]', error.message, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const card = (
      <section className="card" role="alert">
        <div className="card-body">
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>This page ran into a problem</h2>
          <p className="muted" style={{ margin: '0 0 14px' }}>
            Anything you had already saved is safe. Reload the page to try again, or choose another
            page from the menu. If it keeps happening, tell your administrator what you were doing.
          </p>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload the page</button>
            <a className="btn" href="/">Go to the start</a>
          </div>
          {import.meta.env.DEV && (
            <pre className="small muted" style={{ marginTop: 14, whiteSpace: 'pre-wrap' }}>
              {this.state.error.message}
            </pre>
          )}
        </div>
      </section>
    );

    return this.props.fullPage
      ? <div style={{ maxWidth: 480, margin: '12vh auto', padding: 16 }}>{card}</div>
      : card;
  }
}
