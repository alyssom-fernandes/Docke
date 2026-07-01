import { Component, ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
          <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-950 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-red-500" />
          </div>
          <div>
            <p className="text-base font-medium text-[var(--text-primary)]">Algo deu errado</p>
            <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-sm">
              Ocorreu um erro inesperado nesta página.
            </p>
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-[8px] hover:bg-teal-500 transition-colors duration-fast"
          >
            Tentar novamente
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
