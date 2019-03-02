import * as cp from "child_process";
import {
  CancellationToken,
  CodeLens,
  commands,
  DecorationOptions,
  DecorationRangeBehavior,
  DecorationRenderOptions,
  Disposable,
  Position,
  QuickPickItem,
  Range,
  TextDocument,
  TextEditor,
  ThemeColor,
  Uri,
  window,
  workspace,
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ProvideCodeLensesSignature,
  RevealOutputChannelOn,
  ServerOptions,
} from "vscode-languageclient";
import { Converter } from "vscode-languageclient/lib/protocolConverter";
import * as ls from "vscode-languageserver-types";
import * as WebSocket from 'ws';
import { CclsErrorHandler } from "./cclsErrorHandler";
import { cclsChan, logChan } from './globalContext';
import { CallHierarchyProvider } from "./hierarchies/callHierarchy";
import { DataFlowHierarchyProvider } from "./hierarchies/dataFlowHierarchy";
import { InheritanceHierarchyProvider } from "./hierarchies/inheritanceHierarchy";
import { MemberHierarchyProvider } from "./hierarchies/memberHierarchy";
import { InactiveRegionsProvider } from "./inactiveRegions";
import { PublishSemanticHighlightArgs, SemanticContext, semanticTypes } from "./semantic";
import { StatusBarIconProvider } from "./statusBarIcon";
import { ClientConfig, IHierarchyNode } from './types';
import { disposeAll, normalizeUri, unwrap, wait } from "./utils";
import { jumpToUriAtPosition } from "./vscodeUtils";

interface LastGoto {
  id: any;
  clockTime: number;
}

function flatObjectImpl(obj: any, pref: string, result: Map<string, string>) {
  if (typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const newpref = `${pref}.${key}`;
      if (typeof val === "object" || val instanceof Array) {
        flatObjectImpl(val, newpref, result);
      } else {
        result.set(newpref, `${val}`);
      }
    }
  } else if (obj instanceof Array) {
    let idx = 0;
    for (const val of obj) {
      const newpref = `${pref}.${idx}`;
      if (typeof val === "object" || val instanceof Array) {
        flatObjectImpl(val, newpref, result);
      } else {
        result.set(newpref, `${val}`);
      }
      idx++;
    }
  }
}

function flatObject(obj: any, pref = ""): Map<string, string> {
  const result = new Map<string, string>();
  flatObjectImpl(obj, pref, result);
  return result;
}

function getClientConfig(wsRoot: string): ClientConfig {
  function hasAnySemanticHighlight() {
    const hlconfig = workspace.getConfiguration('ccls.highlighting.enabled');
    for (const name of Object.keys(semanticTypes)) {
      if (hlconfig.get(name, false))
        return true;
    }
    return false;
  }

  function resolveVariablesInString(value: string) {
    return value.replace('${workspaceFolder}', wsRoot);
  }

  function resloveVariablesInArray(value: any[]): any[] {
    return value.map((v) => resolveVariables(v));
  }

  function resolveVariables(value: any) {
    if (typeof(value) === 'string') {
      return resolveVariablesInString(value);
    }
    if (Array.isArray(value)) {
        return resloveVariablesInArray(value);
    }
    return value;
  }

  // Read prefs; this map goes from `ccls/js name` => `vscode prefs name`.
  const configMapping: Array<[string, string]> = [
    ['launchCommand', 'launch.command'],
    ['launchArgs', 'launch.args'],
    ['cache.directory', 'cache.directory'],
    ['compilationDatabaseCommand', 'misc.compilationDatabaseCommand'],
    ['compilationDatabaseDirectory', 'misc.compilationDatabaseDirectory'],
    ['clang.excludeArgs', 'clang.excludeArgs'],
    ['clang.extraArgs', 'clang.extraArgs'],
    ['clang.pathMappings', 'clang.pathMappings'],
    ['clang.resourceDir', 'clang.resourceDir'],
    ['codeLens.localVariables', 'codeLens.localVariables'],
    ['completion.caseSensitivity', 'completion.caseSensitivity'],
    ['completion.detailedLabel', 'completion.detailedLabel'],
    ['completion.duplicateOptional', 'completion.duplicateOptional'],
    ['completion.filterAndSort', 'completion.filterAndSort'],
    ['completion.include.maxPathSize', 'completion.include.maxPathSize'],
    ['completion.include.suffixWhitelist', 'completion.include.suffixWhitelist'],
    ['completion.include.whitelist', 'completion.include.whitelist'],
    ['completion.include.blacklist', 'completion.include.blacklist'],
    ['client.snippetSupport', 'completion.enableSnippetInsertion'],
    ['diagnostics.blacklist', 'diagnostics.blacklist'],
    ['diagnostics.whitelist', 'diagnostics.whitelist'],
    ['diagnostics.onChange', 'diagnostics.onChange'],
    ['diagnostics.onOpen', 'diagnostics.onOpen'],
    ['diagnostics.onSave', 'diagnostics.onSave'],
    ['diagnostics.spellChecking', 'diagnostics.spellChecking'],
    ['highlight.blacklist', 'highlight.blacklist'],
    ['highlight.whitelist', 'highlight.whitelist'],
    ['largeFileSize', 'highlight.largeFileSize'],
    ['index.whitelist', 'index.whitelist'],
    ['index.blacklist', 'index.blacklist'],
    ['index.initialWhitelist', 'index.initialWhitelist'],
    ['index.initialBlacklist', 'index.initialBlacklist'],
    ['index.multiVersion', 'index.multiVersion'],
    ['index.onChange', 'index.onChange'],
    ['index.threads', 'index.threads'],
    ['workspaceSymbol.maxNum', 'workspaceSymbol.maxNum'],
    ['workspaceSymbol.caseSensitivity', 'workspaceSymbol.caseSensitivity'],
    ['statusUpdateInterval', 'statusUpdateInterval'],
    ['traceEndpoint', 'trace.websocketEndpointUrl'],
  ];
  const castBooleanToInteger: string[] = [];
  const clientConfig: ClientConfig = {
    cache: {
      directory: '.ccls-cache',
    },
    highlight: {
      enabled: hasAnySemanticHighlight(),
      lsRanges: true,
    },
    launchArgs: [] as string[],
    launchCommand: '',
    statusUpdateInterval: 0,
    traceEndpoint: '',
    workspaceSymbol: {
      sort: false,
    },
  };
  const config = workspace.getConfiguration('ccls');
  for (const prop of configMapping) {
    let value = config.get(prop[1]);
    if (value != null) {
      const subprops = prop[0].split('.');
      let subconfig = clientConfig;
      for (const subprop of subprops.slice(0, subprops.length - 1)) {
        if (!subconfig.hasOwnProperty(subprop)) {
          subconfig[subprop] = {};
        }
        subconfig = subconfig[subprop];
      }
      if (castBooleanToInteger.includes(prop[1])) {
        value = +value;
      }
      subconfig[subprops[subprops.length - 1]] = resolveVariables(value);
    }
  }

  return clientConfig;
}

/** instance represents running instance of ccls */
export class ServerContext implements Disposable {
  private client: LanguageClient;
  private clientPid?: number;
  private cliConfig: ClientConfig;
  private ignoredConf = new Array<string>();
  private _dispose: Disposable[] = [];
  private p2c: Converter;
  private lastGoto: LastGoto = {
    clockTime: 0,
    id: undefined,
  };

  public constructor(
    public readonly cwd: string,
    lazyMode: boolean = false
  ) {
    this.cliConfig = getClientConfig(cwd);
    if (lazyMode) {
      this.ignoredConf.push(".index.initialBlacklist");
      this.cliConfig.index.initialBlacklist = [".*"];
    }
    workspace.onDidChangeConfiguration(this.onDidChangeConfiguration, this, this._dispose);
    this.client = this.initClient();
    this.p2c = this.client.protocol2CodeConverter;
  }

  public dispose() {
    return disposeAll(this._dispose);
  }

  public async start() {
    this._dispose.push(this.client.start());
    try {
      await this.client.onReady();
    } catch (e) {
      window.showErrorMessage(`Failed to start ccls with command "${
        this.cliConfig.launchCommand
      }".`);
    }
    // General commands.
    this._dispose.push(commands.registerCommand("ccls.vars", this.makeRefHandler("$ccls/vars")));
    this._dispose.push(commands.registerCommand("ccls.call", this.makeRefHandler("$ccls/call")));
    this._dispose.push(commands.registerCommand("ccls.member", this.makeRefHandler("$ccls/member")));
    this._dispose.push(commands.registerCommand(
      "ccls.base", this.makeRefHandler("$ccls/inheritance", { derived: false }, true)));
    this._dispose.push(commands.registerCommand("ccls.showXrefs", this.showXrefsHandlerCmd, this));

    // The language client does not correctly deserialize arguments, so we have a
    // wrapper command that does it for us.
    this._dispose.push(commands.registerCommand('ccls.showReferences', this.showReferencesCmd, this));
    this._dispose.push(commands.registerCommand('ccls.goto', this.gotoCmd, this));

    this._dispose.push(commands.registerCommand("ccls._applyFixIt", this.fixItCmd, this));
    this._dispose.push(commands.registerCommand('ccls._autoImplement', this.autoImplementCmd, this));
    this._dispose.push(commands.registerCommand('ccls._insertInclude', this.insertIncludeCmd, this));

    const config = workspace.getConfiguration('ccls');
    if (config.get('misc.showInactiveRegions')) {
      const inact = new InactiveRegionsProvider(this.client);
      this._dispose.push(inact);
    }

    const inheritanceHierarchyProvider = new InheritanceHierarchyProvider(this.client);
    this._dispose.push(inheritanceHierarchyProvider);
    this._dispose.push(window.registerTreeDataProvider(
        "ccls.inheritanceHierarchy", inheritanceHierarchyProvider
    ));

    const callHierarchyProvider = new CallHierarchyProvider(this.client);
    this._dispose.push(callHierarchyProvider);
    this._dispose.push(window.registerTreeDataProvider(
        'ccls.callHierarchy', callHierarchyProvider
    ));

    const memberHierarchyProvider = new MemberHierarchyProvider(this.client);
    this._dispose.push(memberHierarchyProvider);
    this._dispose.push(window.registerTreeDataProvider(
        'ccls.memberHierarchy', memberHierarchyProvider
    ));

    const dfProvier = new DataFlowHierarchyProvider(this.client);
    this._dispose.push(dfProvier);
    this._dispose.push(window.registerTreeDataProvider(
        'ccls.dataFlowInto', dfProvier
    ));

    // Common between tree views.
    this._dispose.push(commands.registerCommand(
        "ccls.gotoForTreeView", this.gotoForTreeView, this
    ));
    this._dispose.push(commands.registerCommand(
        "ccls.hackGotoForTreeView", this.hackGotoForTreeView, this
    ));

    // Semantic highlighting
    const semantic = new SemanticContext();
    this._dispose.push(semantic);
    this.client.onNotification('$ccls/publishSemanticHighlight',
        (args: PublishSemanticHighlightArgs) => semantic.publishSemanticHighlight(args)
    );
    this._dispose.push(commands.registerCommand(
        'ccls.navigate', this.makeNavigateHandler('$ccls/navigate')
    ));

    const interval = this.cliConfig.statusUpdateInterval;
    if (interval) {
      const statusBarIconProvider = new StatusBarIconProvider(this.client, interval);
      this._dispose.push(statusBarIconProvider);
    }

    this._dispose.push(commands.registerCommand("ccls.reload", this.reloadIndex, this));
  }

  public async stop() {
    const pid = unwrap(this.clientPid);
    const serverResponds = await Promise.race([
      (async () => { await wait(300); return false; })(),
      (async () => { await this.client.stop(); return true; })()
    ]);
    // waitpid was called in client.stop
    if (!serverResponds) {
      console.info('Server does not repsond, killing');
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        console.info('Kill failed: ' + (e as Error).message);
      }
    }
    this.clientPid = undefined;
  }

  private reloadIndex() {
    this.client.sendNotification("$ccls/reload");
  }

  private async onDidChangeConfiguration() {
    const newConfig = getClientConfig(this.cwd);
    const newflat = flatObject(newConfig);
    const oldflat = flatObject(this.cliConfig);
    for (const [key, newVal] of newflat) {
      const oldVal = oldflat.get(key);
      if (newVal === undefined || this.ignoredConf.some((e) => key.startsWith(e))) {
        continue;
      }

      if (oldVal !== newVal) {
        const kRestart = 'Restart';
        const message = `Please restart server to apply the "ccls${key}" configuration change.`;

        const selected = await window.showInformationMessage(message, kRestart);
        if (selected === kRestart)
          commands.executeCommand('ccls.restart');
        break;
      }
    }
  }

  private async provideCodeLens(
    document: TextDocument,
    token: CancellationToken,
    next: ProvideCodeLensesSignature
  ): Promise<CodeLens[]> {
    const config = workspace.getConfiguration('ccls');
    const enableCodeLens = config.get('codeLens.enabled');
    if (!enableCodeLens)
      return [];
    const enableInlineCodeLens = config.get('codeLens.renderInline', false);
    if (!enableInlineCodeLens) {
      const uri = document.uri;
      const position = document.positionAt(0);
      const lensesObjs = await this.client.sendRequest<Array<any>>('textDocument/codeLens', {
        position,
        textDocument: {
          uri: uri.toString(true),
        },
      });
      const lenses = this.p2c.asCodeLenses(lensesObjs);
      return lenses.map((lense: CodeLens) => {
        const cmd  = lense.command;
        if (cmd && cmd.command === 'ccls.xref') {
          // Change to a custom command which will fetch and then show the results
          cmd.command = 'ccls.showXrefs';
          cmd.arguments = [
            uri,
            lense.range.start,
            cmd.arguments,
          ];
        }
        return this.p2c.asCodeLens(lense);
      });
    }

    // We run the codeLens request ourselves so we can intercept the response.
    const a = await this.client.sendRequest<ls.CodeLens[]>(
      'textDocument/codeLens',
      {
        textDocument: {
          uri: document.uri.toString(true),
        },
      }
    );
    const result: CodeLens[] = this.p2c.asCodeLenses(a);
    this.displayCodeLens(document, result);
    return [];
  }

  private displayCodeLens(document: TextDocument, allCodeLens: CodeLens[]) {
    const decorationOpts: DecorationRenderOptions = {
      after: {
        color: new ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
      rangeBehavior: DecorationRangeBehavior.ClosedClosed,
    };

    const codeLensDecoration = window.createTextEditorDecorationType(decorationOpts);
    for (const editor of window.visibleTextEditors) {
      if (editor.document !== document)
        continue;

      const opts: DecorationOptions[] = [];

      for (const codeLens of allCodeLens) {
        // FIXME: show a real warning or disable on-the-side code lens.
        if (!codeLens.isResolved)
          console.error('Code lens is not resolved');

        // Default to after the content.
        let position = codeLens.range.end;

        // If multiline push to the end of the first line - works better for
        // functions.
        if (codeLens.range.start.line !== codeLens.range.end.line)
          position = new Position(codeLens.range.start.line, 1000000);

        const range = new Range(position, position);
        const opt: DecorationOptions = {
          range,
          renderOptions:
              {after: {contentText: ' ' + unwrap(codeLens.command, "lens").title + ' '}}
        };

        opts.push(opt);
      }

      editor.setDecorations(codeLensDecoration, opts);
    }
  }

  private initClient(): LanguageClient {
    const args = this.cliConfig.launchArgs;

    const env: any = {};
    const kToForward = [
      'ProgramData',
      'PATH',
      'CPATH',
      'LIBRARY_PATH',
    ];
    for (const e of kToForward)
      env[e] = process.env[e];

    const serverOptions: ServerOptions = async (): Promise<cp.ChildProcess> => {
      const opts: cp.SpawnOptions = {
        cwd: this.cwd,
        env
      };
      const child = cp.spawn(
        this.cliConfig.launchCommand,
        args,
        opts
      );
      this.clientPid = child.pid;
      return child;
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
      diagnosticCollectionName: 'ccls',
      documentSelector: ['c', 'cpp', 'objective-c', 'objective-cpp'],
      // synchronize: {
      // 	configurationSection: 'ccls',
      // 	fileEvents: workspace.createFileSystemWatcher('**/.cc')
      // },
      errorHandler: new CclsErrorHandler(workspace.getConfiguration('ccls')),
      initializationFailedHandler: (e) => {
        console.log(e);
        return false;
      },
      initializationOptions: this.cliConfig,
      middleware: {provideCodeLenses: (doc, next, token) => this.provideCodeLens(doc, next, token)},
      outputChannel: cclsChan,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
    };

    if (this.cliConfig.traceEndpoint) {
      const socket = new WebSocket(this.cliConfig.traceEndpoint);
      let log = '';
      clientOptions.outputChannel = {
        name: 'websocket',
        append(value: string) {
          log += value;
        },
        appendLine(value: string) {
          log += value;
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(log);
          }
          log = '';
        },
        clear() {/**/},
        show() {/**/},
        hide() {/**/},
        dispose() { socket.close(); }
      };
    }

    // Create the language client and start the client.
    return new LanguageClient('ccls', 'ccls', serverOptions, clientOptions);
  }

  private makeRefHandler(
    methodName: string, extraParams: object = {},
    autoGotoIfSingle = false) {
      return async (userParams: any) => {
        /*
        userParams: a dict defined as `args` in keybindings.json (or passed by other extensions like VSCodeVIM)
        Values defined by user have higher priority than `extraParams`
        */
        const editor = unwrap(window.activeTextEditor, "window.activeTextEditor");
        const position = editor.selection.active;
        const uri = editor.document.uri;
        const locations = await this.client.sendRequest<Array<ls.Location>>(
          methodName,
          {
            position,
            textDocument: {
              uri: uri.toString(true),
            },
            ...extraParams,
            ...userParams
          }
        );
        if (autoGotoIfSingle && locations.length === 1) {
          const location = this.p2c.asLocation(locations[0]);
          commands.executeCommand(
              'ccls.goto', location.uri, location.range.start, []);
        } else {
          commands.executeCommand(
              'editor.action.showReferences', uri, position,
              locations.map(this.p2c.asLocation));
        }
    };
  }

  private async showXrefsHandlerCmd(uri: Uri, position: Position, xrefArgs: any[]) {
    const locations = await commands.executeCommand<ls.Location[]>('ccls.xref', ...xrefArgs);
    if (!locations)
      return;
    commands.executeCommand(
      'editor.action.showReferences',
      uri, this.p2c.asPosition(position),
      locations.map(this.p2c.asLocation)
    );
  }

  private showReferencesCmd(uri: string, position: ls.Position, locations: ls.Location[]) {
    commands.executeCommand(
      'editor.action.showReferences',
      this.p2c.asUri(uri),
      this.p2c.asPosition(position),
      locations.map(this.p2c.asLocation)
    );
  }

  private async gotoCmd(uri: string, position: ls.Position, locations: ls.Location[]) {
    return jumpToUriAtPosition(
      this.p2c.asUri(uri),
      this.p2c.asPosition(position),
      false /*preserveFocus*/
    );
  }

  private async fixItCmd(uri: string, pTextEdits: ls.TextEdit[]) {
    const textEdits = this.p2c.asTextEdits(pTextEdits);

    async function applyEdits(editor: TextEditor) {
      const success = await editor.edit((editBuilder) => {
        for (const edit of textEdits) {
          editBuilder.replace(edit.range, edit.newText);
        }
      });
      if (!success) {
        window.showErrorMessage("Failed to apply FixIt");
      }
    }

    // Find existing open document.
    for (const textEditor of window.visibleTextEditors) {
      if (textEditor.document.uri.toString(true) === normalizeUri(uri)) {
        applyEdits(textEditor);
        return;
      }
    }

    // Failed, open new document.
    const d = await workspace.openTextDocument(Uri.parse(uri));
    const e = await window.showTextDocument(d);
    if (!e) { // FIXME seems to be redundant
      window.showErrorMessage("Failed to to get editor for FixIt");
    }

    applyEdits(e);
  }

  private async autoImplementCmd(uri: string, pTextEdits: ls.TextEdit[]) {
    await commands.executeCommand('ccls._applyFixIt', uri, pTextEdits);
    commands.executeCommand('ccls.goto', uri, pTextEdits[0].range.start);
  }

  private async insertIncludeCmd(uri: string, pTextEdits: ls.TextEdit[]) {
    if (pTextEdits.length === 1)
      commands.executeCommand('ccls._applyFixIt', uri, pTextEdits);
    else {
      class MyQuickPick implements QuickPickItem {
        constructor(
            public label: string, public description: string,
            public edit: any) {}
      }
      const items: Array<MyQuickPick> = [];
      for (const edit of pTextEdits) {
        items.push(new MyQuickPick(edit.newText, '', edit));
      }
      const selected = await window.showQuickPick(items);
      if (!selected)
        return;
      commands.executeCommand('ccls._applyFixIt', uri, [selected.edit]);
    }
  }

  private async gotoForTreeView(node: IHierarchyNode) {
    if (!node.location)
      return;

    const parsedUri = Uri.parse(node.location.uri);
    const parsedPosition = this.p2c.asPosition(node.location.range.start);

    return jumpToUriAtPosition(parsedUri, parsedPosition, true /*preserveFocus*/);
  }

  private async hackGotoForTreeView(
    node: IHierarchyNode,
    hasChildren: boolean
  ) {
    if (!node.location)
    return;

    if (!hasChildren) {
      commands.executeCommand('ccls.gotoForTreeView', node);
      return;
    }

    if (this.lastGoto.id !== node.id) {
      this.lastGoto.id = node.id;
      this.lastGoto.clockTime = Date.now();
      return;
    }

    const config = workspace.getConfiguration('ccls');
    const kDoubleClickTimeMs =
        config.get('treeViews.doubleClickTimeoutMs', 500);
    const elapsed = Date.now() - this.lastGoto.clockTime;
    this.lastGoto.clockTime = Date.now();
    if (elapsed < kDoubleClickTimeMs)
      commands.executeCommand('ccls.gotoForTreeView', node);
  }

  private makeNavigateHandler(methodName: string) {
    return async (userParams: any) => {
      const editor = unwrap(window.activeTextEditor, "window.activeTextEditor");
      const position = editor.selection.active;
      const uri = editor.document.uri;
      const locations = await this.client.sendRequest<Array<ls.Location>>(
        methodName,
        {
          position,
          textDocument: {
            uri: uri.toString(true),
          },
          ...userParams
        }
      );
      if (locations.length === 1) {
        const location = this.p2c.asLocation(locations[0]);
        await jumpToUriAtPosition(
          location.uri, location.range.start,
          false /*preserveFocus*/);
      }
    };
  }
}
