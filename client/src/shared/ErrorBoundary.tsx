import React from "react";

type Props = { children: React.ReactNode };

type State = { hasError: boolean; message?: string };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(err: unknown): State {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(error: unknown, info: unknown) {
    // Keep logs visible in production to avoid blank screens without context
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: "#1f2937", background: "#f8fafc", minHeight: "100vh", padding: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Something went wrong.</h2>
          {this.state.message && (
            <p style={{ opacity: 0.8, fontFamily: "monospace" }}>{this.state.message}</p>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
