import { Component, type ReactNode } from 'react';
import { tr } from '../i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
  componentStack: string;
}

/**
 * 错误边界：React 里任何一个 effect 或 render 抛错，默认会把整棵树卸载掉，
 * 用户看到的就是一片黑。这里把它接住并显示出来，方便定位。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '', componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[ErrorBoundary]', error, info);
    this.setState({
      stack: (error.stack || '').slice(0, 1600),
      componentStack: (info?.componentStack || '').slice(0, 1600),
    });
  }

  render() {
    const { error, stack, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-box">
          <h2>{tr('页面出错了')}</h2>
          <p className="crash-hint">
            {tr('把下面这段内容截图或复制给我，就能定位。')}
          </p>

          <div className="crash-label">{tr('错误')}</div>
          <pre className="crash-pre">{error.message || String(error)}</pre>

          {stack && (
            <>
              <div className="crash-label">{tr('调用栈')}</div>
              <pre className="crash-pre">{stack}</pre>
            </>
          )}

          {componentStack && (
            <>
              <div className="crash-label">{tr('组件栈')}</div>
              <pre className="crash-pre">{componentStack}</pre>
            </>
          )}

          <div className="crash-actions">
            <button className="primary" onClick={() => location.reload()}>
              {tr('重新加载')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
