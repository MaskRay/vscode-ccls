import {window, WorkspaceConfiguration} from 'vscode';
import {Message} from 'vscode-jsonrpc';
import {CloseAction, ErrorAction, ErrorHandler} from 'vscode-languageclient';

export class CclsErrorHandler implements ErrorHandler {
  constructor(readonly config: WorkspaceConfiguration) {}

  public error(error: Error, message: Message, count: number): ErrorAction {
    return ErrorAction.Continue;
  }

  public closed(): CloseAction {
    const notifyOnCrash = this.config.get('launch.notifyOnCrash');
    const restart = this.config.get('launch.autoRestart');

    if (notifyOnCrash) {
      window.showInformationMessage(
          restart ? 'ccls has crashed; it has been restarted.' :
                    'ccls has crashed; it has not been restarted.');
    }

    if (restart)
      return CloseAction.Restart;
    return CloseAction.DoNotRestart;
  }
}
