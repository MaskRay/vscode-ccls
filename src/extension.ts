import * as path from "path";
import {
    CodeLens,
    commands,
    DecorationOptions,
    DecorationRangeBehavior,
    DecorationRenderOptions,
    ExtensionContext,
    OverviewRulerLane,
    Position,
    Progress,
    ProgressLocation,
    ProviderResult,
    QuickPickItem,
    Range,
    StatusBarAlignment,
    TextDocument,
    TextEditor,
    TextEditorDecorationType,
    ThemeColor,
    Uri,
    window,
    workspace
} from "vscode";
import { Message } from "vscode-jsonrpc";
import {
    CancellationToken,
    LanguageClient,
    LanguageClientOptions,
    Middleware,
    ProvideCodeLensesSignature,
    RevealOutputChannelOn,
    ServerOptions
} from "vscode-languageclient/lib/main";
import * as ls from "vscode-languageserver-types";

import { CallHierarchyNode, CallHierarchyProvider } from "./callHierarchy";
import { CclsErrorHandler } from "./cclsErrorHandler";
import { DataFlowHierarchyNode, DataFlowHierarchyProvider } from "./dataFlowHierarchy";
import { InheritanceHierarchyNode, InheritanceHierarchyProvider } from "./inheritanceHierarchy";
import { jumpToUriAtPosition } from "./vscodeUtils";

type Nullable<T> = T|null;

export function parseUri(u: string): Uri {
  return Uri.parse(u);
}

function normalizeUri(u: string): string {
  return parseUri(u).toString();
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
class SemanticSymbol {
  constructor(
      readonly id: number, readonly parentKind: SymbolKind,
      readonly kind: SymbolKind, readonly isTypeMember: boolean,
      readonly storage: StorageClass, readonly lsRanges: Array<Range>) {}
}

function getClientConfig(context: ExtensionContext) {
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
    return value.replace('${workspaceFolder}', workspace.rootPath);
  }

  function resloveVariablesInArray(value: any[]) {
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
  const castBooleanToInteger = [];
  const clientConfig = {
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

export function activate(context: ExtensionContext) {
  /////////////////////////////////////
  // Setup configuration, start server.
  /////////////////////////////////////

  // Load configuration and start the client.
  const getLanguageClient = (() => {
    const clientConfig = getClientConfig(context);
    if (!clientConfig)
      return;
    // Notify the user that if they change a ccls setting they need to restart
    // vscode.
    context.subscriptions.push(workspace.onDidChangeConfiguration(() => {
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

          window.showInformationMessage(message, kReload).then((selected) => {
            if (selected === kReload)
              commands.executeCommand('workbench.action.reloadWindow');
          });
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
    console.log(
        `Starting ${serverOptions.command} in ${serverOptions.options.cwd}`);

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
                {after: {contentText: ' ' + codeLens.command.title + ' '}}
          };

          opts.push(opt);
        }

        editor.setDecorations(codeLensDecoration, opts);
      }
    }

    function provideCodeLens(
        document: TextDocument, token: CancellationToken,
        next: ProvideCodeLensesSignature): ProviderResult<CodeLens[]> {
      const enableCodeLens = workspace.getConfiguration().get('editor.codeLens');
      if (!enableCodeLens) return;
      const config = workspace.getConfiguration('ccls');
      const enableInlineCodeLens = config.get('codeLens.renderInline', false);
      if (!enableInlineCodeLens) {
        const uri = document.uri;
        const position = document.positionAt(0);
        return langClient
          .sendRequest<Array<any>>('textDocument/codeLens', {
            position,
            textDocument: {
              uri: uri.toString(),
            },
          })
          .then((lenses: Array<any>) => {
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
          });
      }

      // We run the codeLens request ourselves so we can intercept the response.
      return langClient
          .sendRequest('textDocument/codeLens', {
            textDocument: {
              uri: document.uri.toString(),
            },
          })
          .then((a: ls.CodeLens[]): CodeLens[] => {
            const result: CodeLens[] =
                langClient.protocol2CodeConverter.asCodeLenses(a);
            displayCodeLens(document, result);
            return [];
          });
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
  (() => {
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
      return (userParams) => {
        /*
        userParams: a dict defined as `args` in keybindings.json (or passed by other extensions like VSCodeVIM)
        Values defined by user have higher priority than `extraParams`
        */
        const position = window.activeTextEditor.selection.active;
        const uri = window.activeTextEditor.document.uri;
        languageClient
          .sendRequest<Array<ls.Location>>(methodName, {
              position,
              textDocument: {
                uri: uri.toString(),
              },
              ...extraParams,
              ...userParams
            })
            .then((locations: Array<ls.Location>) => {
              if (autoGotoIfSingle && locations.length === 1) {
                const location = p2c.asLocation(locations[0]);
                commands.executeCommand(
                    'ccls.goto', location.uri, location.range.start, []);
              } else {
                commands.executeCommand(
                    'editor.action.showReferences', uri, position,
                    locations.map(p2c.asLocation));
              }
            });
      };
    }

    function showXrefsHandler(...args) {
      const [uri, position, xrefArgs] = args;
      commands.executeCommand('ccls.xref', ...xrefArgs)
        .then(
          (locations: ls.Location[]) =>
            commands.executeCommand(
              'editor.action.showReferences',
              uri, p2c.asPosition(position),
              locations.map(p2c.asLocation)));
    }

    commands.registerCommand('ccls.vars', makeRefHandler('$ccls/vars'));
    commands.registerCommand('ccls.call', makeRefHandler('$ccls/call'));
    commands.registerCommand('ccls.member', makeRefHandler('$ccls/member'));
    commands.registerCommand(
      'ccls.base', makeRefHandler('$ccls/inheritance', {derived: false}, true));
    commands.registerCommand('ccls.showXrefs', showXrefsHandler);
  })();

  // The language client does not correctly deserialize arguments, so we have a
  // wrapper command that does it for us.
  (() => {
    commands.registerCommand(
        'ccls.showReferences',
        (uri: string, position: ls.Position, locations: ls.Location[]) => {
          commands.executeCommand(
              'editor.action.showReferences', p2c.asUri(uri),
              p2c.asPosition(position), locations.map(p2c.asLocation));
        });

    commands.registerCommand(
        'ccls.goto',
        (uri: string, position: ls.Position, locations: ls.Location[]) => {
          jumpToUriAtPosition(
              p2c.asUri(uri), p2c.asPosition(position),
              false /*preserveFocus*/);
        });
  })();

  // FixIt support
  (() => {
    commands.registerCommand("ccls._applyFixIt", (uri, pTextEdits) => {
      const textEdits = p2c.asTextEdits(pTextEdits);

      function applyEdits(e: TextEditor) {
        e.edit((editBuilder) => {
          for (const edit of textEdits) {
            editBuilder.replace(edit.range, edit.newText);
          }
        }).then((success) => {
          if (!success) {
            window.showErrorMessage("Failed to apply FixIt");
          }
        });
      }

      // Find existing open document.
      for (const textEditor of window.visibleTextEditors) {
        if (textEditor.document.uri.toString() === normalizeUri(uri)) {
          applyEdits(textEditor);
          return;
        }
      }

      // Failed, open new document.
      workspace.openTextDocument(parseUri(uri)).then((d) => {
        window.showTextDocument(d).then((e?: TextEditor) => {
          if (!e) {
            window.showErrorMessage("Failed to to get editor for FixIt");
          }

          applyEdits(e);
        });
      });
    });
  })();

  // AutoImplement
  (() => {
    commands.registerCommand('ccls._autoImplement', (uri, pTextEdits) => {
      commands.executeCommand('ccls._applyFixIt', uri, pTextEdits)
          .then(() => {
            commands.executeCommand(
                'ccls.goto', uri, pTextEdits[0].range.start);
          });
    });
  })();

  // Insert include.
  (() => {
    commands.registerCommand('ccls._insertInclude', (uri, pTextEdits) => {
      if (pTextEdits.length === 1)
        commands.executeCommand('ccls._applyFixIt', uri, pTextEdits);
      else {
        const items: Array<QuickPickItem> = [];
        class MyQuickPick implements QuickPickItem {
          constructor(
              public label: string, public description: string,
              public edit: any) {}
        }
        for (const edit of pTextEdits) {
          items.push(new MyQuickPick(edit.newText, '', edit));
        }
        window.showQuickPick(items).then((selected: MyQuickPick) => {
          commands.executeCommand('ccls._applyFixIt', uri, [selected.edit]);
        });
      }
    });
  })();

  // Inactive regions.
  (() => {
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

    languageClient.onReady().then(() => {
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
    });

    window.onDidChangeActiveTextEditor((editor) => {
      const uri = editor.document.uri.toString();
      if (skippedRanges.has(uri)) {
        editor.setDecorations(decorationType, skippedRanges.get(uri));
      }
    });

    // This only got called during dispose, which perfectly matches our goal.
    workspace.onDidCloseTextDocument((document) => {
      skippedRanges.delete(document.uri.toString());
    });
  })();

  // Inheritance hierarchy.
  (() => {
    const inheritanceHierarchyProvider =
        new InheritanceHierarchyProvider(languageClient);
    window.registerTreeDataProvider(
        'ccls.inheritanceHierarchy', inheritanceHierarchyProvider);
    commands.registerTextEditorCommand(
        'ccls.inheritanceHierarchy', (editor) => {
          setContext('extension.ccls.inheritanceHierarchyVisible', true);

          const position = editor.selection.active;
          const uri = editor.document.uri;
          languageClient
              .sendRequest('$ccls/inheritance', {
                derived: true,
                hierarchy: true,
                levels: 1,
                position,
                qualified: false,
                textDocument: {
                  uri: uri.toString(),
                },
              })
              .then((entry: InheritanceHierarchyNode) => {
                InheritanceHierarchyNode.setWantsDerived(entry, true);

                languageClient
                    .sendRequest('$ccls/inheritance', {
                      derived: false,
                      hierarchy: true,
                      id: entry.id,
                      kind: entry.kind,
                      levels: 1,
                      qualified: false,
                    })
                    .then((parentEntry: InheritanceHierarchyNode) => {
                      if (parentEntry.numChildren > 0) {
                        const parentWrapper = new InheritanceHierarchyNode();
                        parentWrapper.children = parentEntry.children;
                        parentWrapper.numChildren = parentEntry.children.length;
                        parentWrapper.name = '[[Base]]';
                        InheritanceHierarchyNode.setWantsDerived(
                            parentWrapper, false);
                        entry.children.splice(0, 0, parentWrapper);
                        entry.numChildren += 1;
                      }

                      inheritanceHierarchyProvider.root = entry;
                      inheritanceHierarchyProvider.onDidChangeEmitter.fire();
                    });
              });
        });
    commands.registerCommand('ccls.closeInheritanceHierarchy', () => {
      setContext('extension.ccls.inheritanceHierarchyVisible', false);
      inheritanceHierarchyProvider.root = undefined;
      inheritanceHierarchyProvider.onDidChangeEmitter.fire();
    });
  })();

  // Call Hierarchy
  (() => {
    const derivedDark = context.asAbsolutePath(path.join('resources', 'derived-dark.svg'));
    const derivedLight = context.asAbsolutePath(path.join('resources', 'derived-light.svg'));
    const baseDark = context.asAbsolutePath(path.join('resources', 'base-dark.svg'));
    const baseLight = context.asAbsolutePath(path.join('resources', 'base-light.svg'));
    const callHierarchyProvider = new CallHierarchyProvider(
        languageClient, derivedDark, derivedLight, baseDark, baseLight);
    window.registerTreeDataProvider('ccls.callHierarchy', callHierarchyProvider);
    commands.registerTextEditorCommand('ccls.callHierarchy', (editor) => {
      setContext('extension.ccls.callHierarchyVisible', true);
      const position = editor.selection.active;
      const uri = editor.document.uri;
      languageClient
          .sendRequest('$ccls/call', {
            callType: 0x1 | 0x2,
            callee: false,
            hierarchy: true,
            levels: 2,
            position,
            qualified: false,
            textDocument: {
              uri: uri.toString(),
            },
          })
          .then((callNode: CallHierarchyNode) => {
            callHierarchyProvider.root = callNode;
            callHierarchyProvider.onDidChangeEmitter.fire();
          });
    });
    commands.registerCommand('ccls.closeCallHierarchy', (e) => {
      setContext('extension.ccls.callHierarchyVisible', false);
      callHierarchyProvider.root = undefined;
      callHierarchyProvider.onDidChangeEmitter.fire();
    });
  })();

  // DataFlow Hierarchy
  (() => {
    const baseDark = context.asAbsolutePath(path.join('resources', 'base-dark.svg'));
    const baseLight = context.asAbsolutePath(path.join('resources', 'base-light.svg'));
    const dataFlowHierarchyProvider = new DataFlowHierarchyProvider(
        languageClient, baseDark, baseLight);
    window.registerTreeDataProvider('ccls.dataFlowInto', dataFlowHierarchyProvider);
    commands.registerTextEditorCommand('ccls.dataFlowInto', (editor) => {
      setContext('extension.ccls.dataFlowHierarchyVisible', true);
      const position = editor.selection.active;
      const uri = editor.document.uri;
      languageClient
          .sendRequest('$ccls/dataFlowInto', {
            position,
            textDocument: {
              uri: uri.toString(),
            },
          })
          .then((callNode: DataFlowHierarchyNode) => {
            dataFlowHierarchyProvider.root = callNode;
            dataFlowHierarchyProvider.onDidChangeEmitter.fire();
          });
    });
    commands.registerCommand('ccls.closeDataFlowHierarchy', (e) => {
      setContext('extension.ccls.dataFlowHierarchyVisible', false);
      dataFlowHierarchyProvider.root = undefined;
      dataFlowHierarchyProvider.onDidChangeEmitter.fire();
    });
  })();

  // Common between tree views.
  (() => {
    commands.registerCommand(
        'ccls.gotoForTreeView',
        (node: InheritanceHierarchyNode|CallHierarchyNode) => {
          if (!node.location)
            return;

          const parsedUri = parseUri(node.location.uri);
          const parsedPosition = p2c.asPosition(node.location.range.start);

          jumpToUriAtPosition(parsedUri, parsedPosition, true /*preserveFocus*/);
        });

    let lastGotoNodeId: any;
    let lastGotoClickTime: number;
    commands.registerCommand(
        'ccls.hackGotoForTreeView',
        (node: InheritanceHierarchyNode|CallHierarchyNode|DataFlowHierarchyNode,
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
              config.get('treeViews.doubleClickTimeoutMs');
          const elapsed = Date.now() - lastGotoClickTime;
          lastGotoClickTime = Date.now();
          if (elapsed < kDoubleClickTimeMs)
            commands.executeCommand('ccls.gotoForTreeView', node);
        });
  })();

  // Semantic highlighting
  // TODO:
  //   - enable bold/italic decorators, might need change in vscode
  //   - only function call icon if the call is implicit
  (() => {
    function makeSemanticDecorationType(
        color: Nullable<string>, underline: boolean, italic: boolean,
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
        Nullable<TextEditorDecorationType> {
      function get(name: string) {
        if (!semanticEnabled.get(name))
          return undefined;
        const decorations = semanticDecorations.get(name);
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

    class PublishSemanticHighlightArgs {
      readonly uri: string;
      readonly symbols: SemanticSymbol[];
    }

    const cachedDecorations = new Map<string, Map<TextEditorDecorationType, Array<Range>>>();

    function updateDecoration(editor: TextEditor) {
      const uri = editor.document.uri.toString();
      if (cachedDecorations.has(uri)) {
        const cachedDecoration = cachedDecorations.get(uri);
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

    languageClient.onReady().then(() => {
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
                if (decorations.has(type)) {
                  const existing = decorations.get(type);
                  for (const range of symbol.lsRanges)
                    existing.push(range);
                } else {
                  decorations.set(type, symbol.lsRanges);
                }
              }

              cachedDecorations.set(args.uri, decorations);
              updateDecoration(visibleEditor);
            }
          });
    });
  })();

  // Semantic navigation
  (() => {
    function makeNavigateHandler(methodName) {
      return (userParams) => {
        const position = window.activeTextEditor.selection.active;
        const uri = window.activeTextEditor.document.uri;
        languageClient
          .sendRequest<Array<ls.Location>>(methodName, {
              position,
              textDocument: {
                uri: uri.toString(),
              },
              ...userParams
            })
            .then((locations: Array<ls.Location>) => {
              if (locations.length === 1) {
                const location = p2c.asLocation(locations[0]);
                jumpToUriAtPosition(
                    location.uri, location.range.start,
                    false /*preserveFocus*/);
              }
            });
      };
    }
    commands.registerCommand('ccls.navigate', makeNavigateHandler('$ccls/navigate'));
  })();
}
