import {
    CodeLens,
    commands,
    DecorationOptions,
    DecorationRangeBehavior,
    DecorationRenderOptions,
    ExtensionContext,
    Position,
    QuickPickItem,
    Range,
    TextDocument,
    TextEditor,
    TextEditorDecorationType,
    ThemeColor,
    Uri,
    window,
    workspace,
} from "vscode";
import {
    CancellationToken,
    LanguageClient,
    LanguageClientOptions,
    ProvideCodeLensesSignature,
    RevealOutputChannelOn,
    ServerOptions
} from "vscode-languageclient/lib/main";
import * as ls from "vscode-languageserver-types";

import { CallHierarchyNode, CallHierarchyProvider } from "./callHierarchy";
import { CclsErrorHandler } from "./cclsErrorHandler";
import {
  InheritanceHierarchyNode,
  InheritanceHierarchyProvider,
  InheritanceHierarchySetWantsDerived
} from "./inheritanceHierarchy";
import { ClientConfig } from "./types";
import { unwrap } from "./utils";
import { jumpToUriAtPosition } from "./vscodeUtils";

function normalizeUri(u: string): string {
  return Uri.parse(u).toString(true);
}

function setContext(name: string, value: any): void {
  commands.executeCommand("setContext", name, value);
}

enum SymbolKind {
  // lsSymbolKind
  Unknown = 0,
  File,
  Module,
  Namespace,
  Package,

  Class = 5,
  Method,
  Property,
  Field,
  Constructor,

  Enum = 10,
  Interface,
  Function,
  Variable,
  Constant,

  String = 15,
  Number,
  Boolean,
  Array,
  Object,

  Key = 20,
  Null,
  EnumMember,
  Struct,
  Event,

  Operator = 25,
  TypeParameter,

  // ccls extensions
  TypeAlias = 252,
  Parameter = 253,
  StaticMethod = 254,
  Macro = 255
}

enum StorageClass {
  Invalid,
  None,
  Extern,
  Static,
  PrivateExtern,
  Auto,
  Register
}

interface SemanticSymbol {
  readonly id: number;
  readonly parentKind: SymbolKind;
  readonly kind: SymbolKind;
  readonly isTypeMember: boolean;
  readonly storage: StorageClass;
  readonly lsRanges: Range[];
}

function getClientConfig(context: ExtensionContext): ClientConfig {
  const kCacheDirPrefName = 'cacheDirectory';

  function hasAnySemanticHighlight() {
    const options = [
      'ccls.highlighting.enabled.types',
      'ccls.highlighting.enabled.freeStandingFunctions',
      'ccls.highlighting.enabled.memberFunctions',
      'ccls.highlighting.enabled.freeStandingVariables',
      'ccls.highlighting.enabled.memberVariables',
      'ccls.highlighting.enabled.namespaces',
      'ccls.highlighting.enabled.macros',
      'ccls.highlighting.enabled.enums',
      'ccls.highlighting.enabled.typeAliases',
      'ccls.highlighting.enabled.enumConstants',
      'ccls.highlighting.enabled.staticMemberFunctions',
      'ccls.highlighting.enabled.parameters',
      'ccls.highlighting.enabled.templateParameters',
      'ccls.highlighting.enabled.staticMemberVariables',
      'ccls.highlighting.enabled.globalVariables'];
    const wsconfig = workspace.getConfiguration();
    for (const name of options) {
      if (wsconfig.get(name, false))
        return true;
    }
    return false;
  }

  function resolveVariablesInString(value: string) {
    return value.replace('${workspaceFolder}', workspace.rootPath ? workspace.rootPath : "");
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
    ['cacheDirectory', kCacheDirPrefName],
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
  ];
  const castBooleanToInteger: string[] = [];
  const clientConfig: ClientConfig = {
    cacheDirectory: '.ccls-cache',
    highlight: {
      enabled: hasAnySemanticHighlight(),
      lsRanges: true,
    },
    launchArgs: [] as string[],
    launchCommand: '',
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

export async function activate(context: ExtensionContext) {
  /////////////////////////////////////
  // Setup configuration, start server.
  /////////////////////////////////////

  // Load configuration and start the client.
  const getLanguageClient = ((): LanguageClient => {
    const clientConfig = getClientConfig(context);
    // Notify the user that if they change a ccls setting they need to restart
    // vscode.
    context.subscriptions.push(workspace.onDidChangeConfiguration(async () => {
      const newConfig = getClientConfig(context);
      for (const key in newConfig) {
        if (!newConfig.hasOwnProperty(key))
          continue;

        if (!clientConfig ||
            JSON.stringify(clientConfig[key]) !==
                JSON.stringify(newConfig[key])) {
          const kReload = 'Reload';
          const message = `Please reload to apply the "ccls.${
              key}" configuration change.`;

          const selected = await window.showInformationMessage(message, kReload);
          if (selected === kReload)
            commands.executeCommand('workbench.action.reloadWindow');
          break;
        }
      }
    }));

    const args = clientConfig.launchArgs;

    const env: any = {};
    const kToForward = [
      'ProgramData',
      'PATH',
      'CPATH',
      'LIBRARY_PATH',
    ];
    for (const e of kToForward)
      env[e] = process.env[e];

    const serverOptions: ServerOptions = {
      args,
      command: clientConfig.launchCommand,
      options: { env }
    };

    // Inline code lens.
    const decorationOpts: DecorationRenderOptions = {
      after: {
        color: new ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
      rangeBehavior: DecorationRangeBehavior.ClosedClosed,
    };

    const codeLensDecoration = window.createTextEditorDecorationType(
      decorationOpts);

    function displayCodeLens(document: TextDocument, allCodeLens: CodeLens[]) {
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

    async function provideCodeLens(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideCodeLensesSignature
      ): Promise<CodeLens[]> {
      const enableCodeLens = workspace.getConfiguration(undefined, null).get('editor.codeLens');
      if (!enableCodeLens)
        return [];
      const config = workspace.getConfiguration('ccls');
      const enableInlineCodeLens = config.get('codeLens.renderInline', false);
      if (!enableInlineCodeLens) {
        const uri = document.uri;
        const position = document.positionAt(0);
        const lenses = await langClient.sendRequest<Array<any>>('textDocument/codeLens', {
          position,
          textDocument: {
            uri: uri.toString(),
          },
        });
        return lenses.map((lense) => {
          const cmd  = lense.command;
          if (cmd.command === 'ccls.xref') {
            // Change to a custom command which will fetch and then show the results
            cmd.command = 'ccls.showXrefs';
            cmd.arguments = [
              uri,
              lense.range.start,
              cmd.arguments,
            ];
          }
          return p2c.asCodeLens(lense);
        });
      }

      // We run the codeLens request ourselves so we can intercept the response.
      const a = await langClient.sendRequest<ls.CodeLens[]>(
        'textDocument/codeLens',
        {
          textDocument: {
            uri: document.uri.toString(),
          },
        }
      );
      const result: CodeLens[] =
          langClient.protocol2CodeConverter.asCodeLenses(a);
      displayCodeLens(document, result);
      return [];
    }

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
      initializationOptions: clientConfig,
      middleware: {provideCodeLenses: provideCodeLens},
      outputChannelName: 'ccls',
      revealOutputChannelOn: RevealOutputChannelOn.Never,
    };

    // Create the language client and start the client.
    const langClient =
        new LanguageClient('ccls', 'ccls', serverOptions, clientOptions);
    const command = serverOptions.command;
    langClient.onReady().catch((e) => {
      window.showErrorMessage(`Failed to start ccls with command "${command}".`);
    });
    context.subscriptions.push(langClient.start());

    return langClient;
  });

  let languageClient = getLanguageClient();

  const p2c = languageClient.protocol2CodeConverter;

  // General commands.
  {
    commands.registerCommand('ccls.reload', () => {
      languageClient.sendNotification('$ccls/reload');
    });
    commands.registerCommand('ccls.restart', () => {
      languageClient.stop();
      languageClient = getLanguageClient();
    });

    function makeRefHandler(
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
        const locations = await languageClient.sendRequest<Array<ls.Location>>(
          methodName,
          {
            position,
            textDocument: {
              uri: uri.toString(),
            },
            ...extraParams,
            ...userParams
          }
        );
        if (autoGotoIfSingle && locations.length === 1) {
          const location = p2c.asLocation(locations[0]);
          commands.executeCommand(
              'ccls.goto', location.uri, location.range.start, []);
        } else {
          commands.executeCommand(
              'editor.action.showReferences', uri, position,
              locations.map(p2c.asLocation));
        }
      };
    }

    async function showXrefsHandler(...args: any[]) { // TODO fix any
      const [uri, position, xrefArgs] = args;
      const locations = await commands.executeCommand<ls.Location[]>('ccls.xref', ...xrefArgs);
      if (!locations)
        return;
      commands.executeCommand(
        'editor.action.showReferences',
        uri, p2c.asPosition(position),
        locations.map(p2c.asLocation)
      );
    }

    commands.registerCommand('ccls.vars', makeRefHandler('$ccls/vars'));
    commands.registerCommand('ccls.call', makeRefHandler('$ccls/call'));
    commands.registerCommand('ccls.member', makeRefHandler('$ccls/member'));
    commands.registerCommand(
      'ccls.base', makeRefHandler('$ccls/inheritance', {derived: false}, true));
    commands.registerCommand('ccls.showXrefs', showXrefsHandler);
  }

  // The language client does not correctly deserialize arguments, so we have a
  // wrapper command that does it for us.
  {
    commands.registerCommand(
        'ccls.showReferences',
        (uri: string, position: ls.Position, locations: ls.Location[]) => {
          commands.executeCommand(
              'editor.action.showReferences', p2c.asUri(uri),
              p2c.asPosition(position), locations.map(p2c.asLocation));
        });

    commands.registerCommand(
        'ccls.goto',
        async (uri: string, position: ls.Position, locations: ls.Location[]) => {
          return jumpToUriAtPosition(
              p2c.asUri(uri), p2c.asPosition(position),
              false /*preserveFocus*/);
        });
  }

  // FixIt support
  {
    commands.registerCommand("ccls._applyFixIt", async (uri, pTextEdits) => {
      const textEdits = p2c.asTextEdits(pTextEdits);

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
        if (textEditor.document.uri.toString() === normalizeUri(uri)) {
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
    });
  }

  // AutoImplement
  {
    commands.registerCommand('ccls._autoImplement', async (uri, pTextEdits) => {
      await commands.executeCommand('ccls._applyFixIt', uri, pTextEdits);
      commands.executeCommand('ccls.goto', uri, pTextEdits[0].range.start);
    });
  }

  // Insert include.
  {
    commands.registerCommand('ccls._insertInclude', async (uri, pTextEdits) => {
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
    });
  }

  // Inactive regions.
  {
    const config = workspace.getConfiguration('ccls');
    if (!config.get('misc.showInactiveRegions')) return;
    const decorationType = window.createTextEditorDecorationType({
      dark: {
        backgroundColor: config.get('theme.dark.skippedRange.backgroundColor'),
        color: config.get('theme.dark.skippedRange.textColor'),
      },
      isWholeLine: true,
      light: {
        backgroundColor: config.get('theme.light.skippedRange.backgroundColor'),
        color: config.get('theme.light.skippedRange.textColor'),
      },
      rangeBehavior: DecorationRangeBehavior.ClosedClosed
    });

    const skippedRanges = new Map<string, Range[]>();

    await languageClient.onReady();
    languageClient.onNotification("$ccls/publishSkippedRanges", (args) => {
      const uri = normalizeUri(args.uri);
      let ranges: Range[] = args.skippedRanges.map(p2c.asRange);
      ranges = ranges.map((range) => {
        if (range.isEmpty || range.isSingleLine) return range;
        return range.with({ end: range.end.translate(-1, 23333) });
      });
      skippedRanges.set(uri, ranges);
      window.visibleTextEditors
        .filter((editor) => editor.document.uri.toString() === uri)
        .forEach((editor) => editor.setDecorations(decorationType, ranges));
    });

    window.onDidChangeActiveTextEditor((editor?: TextEditor) => {
      if (!editor)
        return;
      const uri = editor.document.uri.toString();
      const range = skippedRanges.get(uri);
      if (range) {
        editor.setDecorations(decorationType, range);
      }
    });

    // This only got called during dispose, which perfectly matches our goal.
    workspace.onDidCloseTextDocument((document) => {
      skippedRanges.delete(document.uri.toString());
    });
  }

  // Inheritance hierarchy.
  {
    const inheritanceHierarchyProvider =
        new InheritanceHierarchyProvider(languageClient);
    window.registerTreeDataProvider(
        'ccls.inheritanceHierarchy', inheritanceHierarchyProvider);
    commands.registerTextEditorCommand(
        'ccls.inheritanceHierarchy', async (editor) => {
          setContext('extension.ccls.inheritanceHierarchyVisible', true);

          const position = editor.selection.active;
          const uri = editor.document.uri;
          const entry = await languageClient.sendRequest<InheritanceHierarchyNode>('$ccls/inheritance', {
            derived: true,
            hierarchy: true,
            levels: 1,
            position,
            qualified: false,
            textDocument: {
              uri: uri.toString(),
            },
          });
          InheritanceHierarchySetWantsDerived(entry, true);

          const parentEntry = await languageClient.sendRequest<InheritanceHierarchyNode>(
            '$ccls/inheritance',
            {
              derived: false,
              hierarchy: true,
              id: entry.id,
              kind: entry.kind,
              levels: 1,
              qualified: false,
            }
          );
          if (parentEntry.numChildren > 0) {
            const parentWrapper: InheritanceHierarchyNode = {
              children: parentEntry.children,
              id: undefined,
              kind: -1,
              location: undefined,
              name: '[[Base]]',
              numChildren: parentEntry.children.length,
              wantsDerived: false
            };
            InheritanceHierarchySetWantsDerived(
                parentWrapper, false);
            entry.children.unshift(parentWrapper);
            entry.numChildren += 1;
          }

          inheritanceHierarchyProvider.root = entry;
          inheritanceHierarchyProvider.onDidChangeEmitter.fire();
          commands.executeCommand("workbench.view.explorer");
        });
    commands.registerCommand('ccls.closeInheritanceHierarchy', () => {
      setContext('extension.ccls.inheritanceHierarchyVisible', false);
      inheritanceHierarchyProvider.root = undefined;
      inheritanceHierarchyProvider.onDidChangeEmitter.fire();
    });
  }

  // Call Hierarchy
  {
    const callHierarchyProvider = new CallHierarchyProvider(languageClient);
    window.registerTreeDataProvider('ccls.callHierarchy', callHierarchyProvider);
    commands.registerTextEditorCommand('ccls.callHierarchy', async (editor) => {
      setContext('extension.ccls.callHierarchyVisible', true);
      const position = editor.selection.active;
      const uri = editor.document.uri;
      const callNode = await languageClient.sendRequest<CallHierarchyNode>(
        '$ccls/call',
        {
          callType: 0x1 | 0x2,
          callee: false,
          hierarchy: true,
          levels: 2,
          position,
          qualified: false,
          textDocument: {
            uri: uri.toString(),
          },
        }
      );
      callHierarchyProvider.root = callNode;
      callHierarchyProvider.onDidChangeEmitter.fire();
      commands.executeCommand("workbench.view.explorer");
    });
    commands.registerCommand('ccls.closeCallHierarchy', (e) => {
      setContext('extension.ccls.callHierarchyVisible', false);
      callHierarchyProvider.root = undefined;
      callHierarchyProvider.onDidChangeEmitter.fire();
    });
  }

  // Common between tree views.
  {
    commands.registerCommand(
        'ccls.gotoForTreeView',
        async (node: InheritanceHierarchyNode|CallHierarchyNode) => {
          if (!node.location)
            return;

          const parsedUri = Uri.parse(node.location.uri);
          const parsedPosition = p2c.asPosition(node.location.range.start);

          return jumpToUriAtPosition(parsedUri, parsedPosition, true /*preserveFocus*/);
        });

    let lastGotoNodeId: any;
    let lastGotoClickTime: number;
    commands.registerCommand(
        'ccls.hackGotoForTreeView',
        (node: InheritanceHierarchyNode|CallHierarchyNode,
         hasChildren: boolean) => {
          if (!node.location)
            return;

          if (!hasChildren) {
            commands.executeCommand('ccls.gotoForTreeView', node);
            return;
          }

          if (lastGotoNodeId !== node.id) {
            lastGotoNodeId = node.id;
            lastGotoClickTime = Date.now();
            return;
          }

          const config = workspace.getConfiguration('ccls');
          const kDoubleClickTimeMs =
              config.get('treeViews.doubleClickTimeoutMs', 500);
          const elapsed = Date.now() - lastGotoClickTime;
          lastGotoClickTime = Date.now();
          if (elapsed < kDoubleClickTimeMs)
            commands.executeCommand('ccls.gotoForTreeView', node);
        });
  }

  // Semantic highlighting
  // TODO:
  //   - enable bold/italic decorators, might need change in vscode
  //   - only function call icon if the call is implicit
  {
    function makeSemanticDecorationType(
        color: string|null, underline: boolean, italic: boolean,
        bold: boolean): TextEditorDecorationType {
      const opts: any = {};
      opts.rangeBehavior = DecorationRangeBehavior.ClosedClosed;
      opts.color = color;
      if (underline === true)
        opts.textDecoration = 'underline';
      if (italic === true)
        opts.fontStyle = 'italic';
      if (bold === true)
        opts.fontWeight = 'bold';
      return window.createTextEditorDecorationType(
          opts as DecorationRenderOptions);
    }

    function makeDecorations(type: string) {
      const config = workspace.getConfiguration('ccls');
      const colors = config.get(`highlighting.colors.${type}`, []);
      const u = config.get(`highlighting.underline.${type}`, false);
      const i = config.get(`highlighting.italic.${type}`, false);
      const b = config.get(`highlighting.bold.${type}`, false);
      return colors.map((c) => makeSemanticDecorationType(c, u, i, b));
    }
    const semanticDecorations = new Map<string, TextEditorDecorationType[]>();
    const semanticEnabled = new Map<string, boolean>();
    for (const type of
             ['types', 'freeStandingFunctions', 'memberFunctions',
              'freeStandingVariables', 'memberVariables', 'namespaces',
              'macros', 'enums', 'typeAliases', 'enumConstants',
              'staticMemberFunctions', 'parameters', 'templateParameters',
              'staticMemberVariables', 'globalVariables']) {
      semanticDecorations.set(type, makeDecorations(type));
      semanticEnabled.set(type, false);
    }

    function updateConfigValues() {
      // Fetch new config instance, since vscode will cache the previous one.
      const config = workspace.getConfiguration('ccls');
      for (const [name, value] of semanticEnabled) {
        semanticEnabled.set(
            name, config.get(`highlighting.enabled.${name}`, false));
      }
    }
    updateConfigValues();

    function tryFindDecoration(symbol: SemanticSymbol):
        TextEditorDecorationType|undefined {
      function get(name: string) {
        if (!semanticEnabled.get(name))
          return undefined;
        const decorations = unwrap(semanticDecorations.get(name), "semantic");
        return decorations[symbol.id % decorations.length];
      }

      if (symbol.kind === SymbolKind.Class || symbol.kind === SymbolKind.Struct) {
        return get('types');
      } else if (symbol.kind === SymbolKind.Enum) {
        return get('enums');
      } else if (symbol.kind === SymbolKind.TypeAlias) {
        return get('typeAliases');
      } else if (symbol.kind === SymbolKind.TypeParameter) {
        return get('templateParameters');
      } else if (symbol.kind === SymbolKind.Function) {
        return get('freeStandingFunctions');
      } else if (
          symbol.kind === SymbolKind.Method ||
          symbol.kind === SymbolKind.Constructor) {
        return get('memberFunctions');
      } else if (symbol.kind === SymbolKind.StaticMethod) {
        return get('staticMemberFunctions');
      } else if (symbol.kind === SymbolKind.Variable) {
        if (symbol.parentKind === SymbolKind.Function ||
            symbol.parentKind === SymbolKind.Method ||
            symbol.parentKind === SymbolKind.Constructor) {
          return get('freeStandingVariables');
        }
        return get('globalVariables');
      } else if (symbol.kind === SymbolKind.Field) {
        if (symbol.storage === StorageClass.Static) {
          return get('staticMemberVariables');
        }
        return get('memberVariables');
      } else if (symbol.kind === SymbolKind.Parameter) {
        return get('parameters');
      } else if (symbol.kind === SymbolKind.EnumMember) {
        return get('enumConstants');
      } else if (symbol.kind === SymbolKind.Namespace) {
        return get('namespaces');
      } else if (symbol.kind === SymbolKind.Macro) {
        return get('macros');
      }
    }

    interface PublishSemanticHighlightArgs {
      readonly uri: string;
      readonly symbols: SemanticSymbol[];
    }

    const cachedDecorations = new Map<string, Map<TextEditorDecorationType, Array<Range>>>();

    function updateDecoration(editor: TextEditor) {
      const uri = editor.document.uri.toString();
      const cachedDecoration = cachedDecorations.get(uri);
      if (cachedDecoration) {
        // Clear decorations and set new ones. We might not use all of the
        // decorations so clear before setting.
        for (const [_, decorations] of semanticDecorations) {
          decorations.forEach((type) => {
            editor.setDecorations(type, []);
          });
        }
        // Set new decorations.
        cachedDecoration.forEach((ranges, type) => {
          editor.setDecorations(type, ranges);
        });
      }
    }

    window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor) {
          updateDecoration(editor);
        }
      },
      null,
      context.subscriptions
    );

    await languageClient.onReady();
    languageClient.onNotification(
        '$ccls/publishSemanticHighlight',
        (args: PublishSemanticHighlightArgs) => {
          updateConfigValues();

          for (const visibleEditor of window.visibleTextEditors) {
            if (normalizeUri(args.uri) !== visibleEditor.document.uri.toString())
              continue;

            const decorations = new Map<TextEditorDecorationType, Array<Range>>();

            for (const symbol of args.symbols) {
              const type = tryFindDecoration(symbol);
              if (!type)
                continue;
              const existing = decorations.get(type);
              if (existing) {
                for (const range of symbol.lsRanges) {
                  existing.push(range);
                }
              } else {
                decorations.set(type, symbol.lsRanges);
              }
            }

            cachedDecorations.set(args.uri, decorations);
            updateDecoration(visibleEditor);
          }
        });
  }

  // Semantic navigation
  {
    function makeNavigateHandler(methodName: string) {
      return async (userParams: any) => {
        const editor = unwrap(window.activeTextEditor, "window.activeTextEditor");
        const position = editor.selection.active;
        const uri = editor.document.uri;
        const locations = await languageClient.sendRequest<Array<ls.Location>>(
          methodName,
          {
            position,
            textDocument: {
              uri: uri.toString(),
            },
            ...userParams
          }
        );
        if (locations.length === 1) {
          const location = p2c.asLocation(locations[0]);
          await jumpToUriAtPosition(
            location.uri, location.range.start,
            false /*preserveFocus*/);
        }
      };
    }
    commands.registerCommand('ccls.navigate', makeNavigateHandler('$ccls/navigate'));
  }
}
