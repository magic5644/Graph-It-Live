import { useEffect, useState } from 'react';
import { VSCodeAPI, WebviewMessage, ExtensionMessage } from '../../shared/protocol';

let vscode: VSCodeAPI | undefined;

export function useVSCodeAPI() {
  const [api] = useState<VSCodeAPI>(() => {
    if (!vscode) {
      vscode = window.acquireVsCodeApi();
    }
    return vscode;
  });

  const postMessage = (message: WebviewMessage) => {
    api.postMessage(message);
  };

  const onMessage = (callback: (message: ExtensionMessage) => void) => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      callback(event.data);
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  };

  useEffect(() => {
    // Notify extension that webview is ready
    postMessage({ command: 'ready' });
  }, []);

  return { postMessage, onMessage };
}
