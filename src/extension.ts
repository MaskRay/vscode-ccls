import * as path from 'path';
import {CodeLens, commands, DecorationOptions, DecorationRangeBehavior, DecorationRenderOptions, ExtensionContext, OverviewRulerLane, Position, Progress, ProgressLocation, ProviderResult, QuickPickItem, Range, StatusBarAlignment, TextDocument, TextEditor, TextEditorDecorationType, ThemeColor, Uri, window, workspace} from 'vscode';
import {Message} from 'vscode-jsonrpc';
import {CancellationToken, LanguageClient, LanguageClientOptions, Middleware, ProvideCodeLensesSignature, RevealOutputChannelOn, ServerOptions} from 'vscode-languageclient/lib/main';
import * as ls from 'vscode-languageserver-types';

import {CallHierarchyNode, CallHierarchyProvider} from './callHierarchy';
import {cclsErrorHandler} from './cclsErrorHandler';
import {InheritanceHierarchyNode, InheritanceHierarchyProvider} from './inheritanceHierarchy';
import {jumpToUriAtPosition} from './vscodeUtils';

type Nullable<T> = T|null;

export function parseUri(u): Uri {
  return Uri.parse(u);
}

function setContext(name, value) {
  commands.executeCommand('setContext', name, value);
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
      readonly stableId: number, readonly parentKind: SymbolKind,
      readonly kind: SymbolKind, readonly isTypeMember: boolean,
      readonly storage: StorageClass, readonly lsRanges: Array<Range>) {}
}

function getClientConfig(context: ExtensionContext) {
  const kCacheDirPrefName = 'cacheDirectory';

  function hasAnySemanticHighlighting() {
    let options = [
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
    let config = workspace.getConfiguration();
    for (let name of options) {
      if (config.get(name, false))
        return true;
    }
    return false;
  }

  function resolveVariablesInString(value: string) {
    return value.replace('${workspaceFolder}', workspace.rootPath);
  }

  function resloveVariablesInArray(value: any[]) {
    return value.map(v => resolveVariables(v));
  }

  function resolveVariables(value: any) {
    if (typeof(value) == 'string') {
      return resolveVariablesInString(value);
    }
    if (Array.isArray(value)) {
        return resloveVariablesInArray(value);
    }
    return value
  }

  // Read prefs; this map goes from `ccls/js name` => `vscode prefs name`.
  let configMapping = [
    ['launchCommand', 'launch.command'],
    ['launchArgs', 'launch.args'],
    ['cacheDirectory', kCacheDirPrefName],
    ['emitQueryDbBlocked', 'developer.emitQueryDbBlocked'],
    ['index.whitelist', 'index.whitelist'],
    ['index.blacklist', 'index.blacklist'],
    ['index.logSkippedPaths', 'log.skippedPathsForIndex'],
    ['extraClangArguments', 'index.extraClangArguments'],
    ['resourceDirectory', 'misc.resourceDirectory'],
    ['workspaceSymbol.maxNum', 'misc.maxWorkspaceSearchResults'],
    ['index.threads', 'misc.indexerCount'],
    ['index.enabled', 'misc.enableIndexing'],
    ['enableCacheWrite', 'misc.enableCacheWrite'],
    ['enableCacheRead', 'misc.enableCacheRead'],
    ['compilationDatabaseDirectory', 'misc.compilationDatabaseDirectory'],
    ['completion.enableSnippets', 'completion.enableSnippetInsertion'],
    ['completion.includeMaxPathSize', 'completion.include.maximumPathLength'],
    ['completion.includeSuffixWhitelist', 'completion.include.whitelistLiteralEnding'],
    ['completion.includeWhitelist', 'completion.include.whitelist'],
    ['completion.includeBlacklist', 'completion.include.blacklist'],
    ['showDocumentLinksOnIncludes', 'showDocumentLinksOnIncludes'],
    ['diagnostics.blacklist', 'diagnostics.blacklist'],
    ['diagnostics.whitelist', 'diagnostics.whitelist'],
    ['diagnostics.onParse', 'diagnostics.onParse'],
    ['diagnostics.onType', 'diagnostics.onType'],
    ['codeLens.localVariables', 'codeLens.onLocalVariables'],
    ['emitInactiveRegions', 'misc.showInactiveRegions'],
    ['discoverSystemIncludes','misc.discoverSystemIncludes'],
    ['formatting.enabled', 'formatting.enabled'],
  ];
  let clientConfig = {
    launchCommand: '',
    cacheDirectory: '',
    highlight: {
      lsRanges: true,
      enabled: hasAnySemanticHighlighting(),
    },
    workspaceSymbol: {
      sort: false,
    },
  };
  let config = workspace.getConfiguration('ccls');
  for (let prop of configMapping) {
    let value = config.get(prop[1]);
    if (value != null) {
      let subprops = prop[0].split('.');
      let subconfig = clientConfig;
      for (let subprop of subprops.slice(0, subprops.length - 1)) {
        if (!subconfig.hasOwnProperty(subprop)) {
          subconfig[subprop] = {};
        }
        subconfig = subconfig[subprop];
      }
      subconfig[subprops[subprops.length - 1]] = resolveVariables(value);
    }
  }

  // Set up a cache directory if there is not one.
  if (!clientConfig.cacheDirectory) {
    if (!context.storagePath) {
      const kOpenSettings = 'Open Settings';
      window
          .showErrorMessage(
              'Could not auto-discover cache directory. Please use "Open Folder" ' +
                  'or specify it in the |ccls.cacheDirectory| setting.',
              kOpenSettings)
          .then((selected) => {
            if (selected == kOpenSettings)
              commands.executeCommand('workbench.action.openWorkspaceSettings');
          });
      return;
    }

    // Provide a default cache directory if it is not present. Insert next to
    // the project since if the user has an SSD they most likely have their
    // source files on the SSD as well.
    let cacheDir = '${workspaceFolder}/.vscode/ccls_cached_index/';
    clientConfig.cacheDirectory = resolveVariables(cacheDir);
    config.update(kCacheDirPrefName, cacheDir, false /*global*/);
  }

  return clientConfig;
}



export function activate(context: ExtensionContext) {
  /////////////////////////////////////
  // Setup configuration, start server.
  /////////////////////////////////////

  // Load configuration and start the client.
  let getLanguageClient = (() => {
    let clientConfig = getClientConfig(context);
    if (!clientConfig)
      return;
    // Notify the user that if they change a ccls setting they need to restart
    // vscode.
    context.subscriptions.push(workspace.onDidChangeConfiguration(() => {
      let newConfig = getClientConfig(context);
      for (let key in newConfig) {
        if (!newConfig.hasOwnProperty(key))
          continue;

        if (!clientConfig ||
            JSON.stringify(clientConfig[key]) !=
                JSON.stringify(newConfig[key])) {
          const kReload = 'Reload'
          const message = `Please reload to apply the "ccls.${
              key}" configuration change.`;

          window.showInformationMessage(message, kReload).then(selected => {
            if (selected == kReload)
              commands.executeCommand('workbench.action.reloadWindow');
          });
          break;
        }
      }
    }));

    let args = clientConfig['launchArgs'];

    let env: any = {};
    let kToForward = [
      'ProgramData',
      'PATH',
    ];
    for (let e of kToForward)
      env[e] = process.env[e];

    // env.LIBCLANG_LOGGING = '1';
    // env.MALLOC_CHECK_ = '2';

    let serverOptions: ServerOptions = {
      command: clientConfig.launchCommand,
      args: args,
      options: {env: env}
    };
    console.log(
        `Starting ${serverOptions.command} in ${serverOptions.options.cwd}`);


    // Inline code lens.
    let decorationOpts: DecorationRenderOptions = {
      after: {
        fontStyle: 'italic',
        color: new ThemeColor('editorCodeLens.foreground'),
      },
      rangeBehavior: DecorationRangeBehavior.ClosedClosed,
    };

    let codeLensDecoration = window.createTextEditorDecorationType(
      decorationOpts);

    function displayCodeLens(document: TextDocument, allCodeLens: CodeLens[]) {
      for (let editor of window.visibleTextEditors) {
        if (editor.document != document)
          continue;

        let opts: DecorationOptions[] = [];

        for (let codeLens of allCodeLens) {
          // FIXME: show a real warning or disable on-the-side code lens.
          if (!codeLens.isResolved)
            console.error('Code lens is not resolved');

          // Default to after the content.
          let position = codeLens.range.end;

          // If multiline push to the end of the first line - works better for
          // functions.
          if (codeLens.range.start.line != codeLens.range.end.line)
            position = new Position(codeLens.range.start.line, 1000000);

          let range = new Range(position, position);
          let opt: DecorationOptions = {
            range: range,
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
      let enableCodeLens = workspace.getConfiguration().get('editor.codeLens');
      if (!enableCodeLens) return;
      let config = workspace.getConfiguration('ccls');
      let enableInlineCodeLens = config.get('codeLens.renderInline', false);
      if (!enableInlineCodeLens) {
        let uri = document.uri;
        let position = document.positionAt(0);
        return languageClient
          .sendRequest<Array<any>>('textDocument/codeLens', {
            textDocument: {
              uri: uri.toString(),
            },
            position: position
          })
          .then((lenses: Array<any>) => {
            return lenses.map(lense => {
              let command  = lense.command;
              command.arguments = [ command.arguments.uri, command.arguments.position, command.arguments.locations ]
              return p2c.asCodeLens(lense);
            });
          });
      }

      // We run the codeLens request ourselves so we can intercept the response.
      return languageClient
          .sendRequest('textDocument/codeLens', {
            textDocument: {
              uri: document.uri.toString(),
            },
          })
          .then((a: ls.CodeLens[]): CodeLens[] => {
            let result: CodeLens[] =
                languageClient.protocol2CodeConverter.asCodeLenses(a);
            displayCodeLens(document, result);
            return [];
          });
    };

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
      documentSelector: ['c', 'cpp', 'objective-c', 'objective-cpp'],
      // synchronize: {
      // 	configurationSection: 'ccls',
      // 	fileEvents: workspace.createFileSystemWatcher('**/.cc')
      // },
      diagnosticCollectionName: 'ccls',
      outputChannelName: 'ccls',
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      initializationOptions: clientConfig,
      middleware: {provideCodeLenses: provideCodeLens},
      initializationFailedHandler: (e) => {
        console.log(e);
        return false;
      },
      errorHandler: new cclsErrorHandler(workspace.getConfiguration('ccls'))
    }

    // Create the language client and start the client.
    let languageClient =
        new LanguageClient('ccls', 'ccls', serverOptions, clientOptions);
    let command = serverOptions.command
    languageClient.onReady().catch(e => {
      // TODO: remove ccls.launch.workingDirectory after July 2018
      window.showErrorMessage(
          'ccls.launch.command has changed; either add ccls to your PATH ' +
          'or make ccls.launch.command an absolute path. Current value: "' +
          command + '". ccls.launch.workingDirectory has been removed.');
    });
    context.subscriptions.push(languageClient.start());

    return languageClient;
  });

  let languageClient = getLanguageClient();

  let p2c = languageClient.protocol2CodeConverter;

  // General commands.
  (() => {
    commands.registerCommand('ccls.freshenIndex', () => {
      languageClient.sendNotification('$ccls/freshenIndex');
    });
    commands.registerCommand('ccls.restart', () => {
      languageClient.stop();
      languageClient = getLanguageClient();
    });

    function makeRefHandler(methodName, autoGotoIfSingle = false) {
      return () => {
        let position = window.activeTextEditor.selection.active;
        let uri = window.activeTextEditor.document.uri;
        languageClient
          .sendRequest<Array<ls.Location>>(methodName, {
              textDocument: {
                uri: uri.toString(),
              },
              position: position
            })
            .then((locations: Array<ls.Location>) => {
              if (autoGotoIfSingle && locations.length == 1) {
                let location = p2c.asLocation(locations[0]);
                commands.executeCommand(
                    'ccls.goto', location.uri, location.range.start, []);
              } else {
                commands.executeCommand(
                    'editor.action.showReferences', uri, position,
                    locations.map(p2c.asLocation));
              }
            })
      }
    }
    commands.registerCommand('ccls.vars', makeRefHandler('$ccls/vars'));
    commands.registerCommand(
        'ccls.callers', makeRefHandler('$ccls/callers'));
    commands.registerCommand(
        'ccls.base', makeRefHandler('$ccls/base', true));
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
    commands.registerCommand('ccls._applyFixIt', (uri, pTextEdits) => {
      const textEdits = p2c.asTextEdits(pTextEdits);

      function applyEdits(e: TextEditor) {
        e.edit(editBuilder => {
           for (const edit of textEdits)
             editBuilder.replace(edit.range, edit.newText);
         }).then(success => {
          if (!success)
            window.showErrorMessage('Failed to apply FixIt');
        });
      }

      // Find existing open document.
      for (const textEditor of window.visibleTextEditors) {
        if (textEditor.document.uri.toString() == uri) {
          applyEdits(textEditor);
          return;
        }
      }

      // Failed, open new document.
      workspace.openTextDocument(parseUri(uri))
          .then(d => {window.showTextDocument(d).then(e => {
                  if (!e)
                    window.showErrorMessage(
                        'Failed to to get editor for FixIt');

                  applyEdits(e);
                })});
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
      if (pTextEdits.length == 1)
        commands.executeCommand('ccls._applyFixIt', uri, pTextEdits);
      else {
        let items: Array<QuickPickItem> = [];
        class MyQuickPick implements QuickPickItem {
          constructor(
              public label: string, public description: string,
              public edit: any) {}
        }
        for (let edit of pTextEdits) {
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
    let config = workspace.getConfiguration('ccls');
    const skippedRangeDecorationType = window.createTextEditorDecorationType({
      isWholeLine: true,
      light: {
        color: config.get('theme.light.skippedRange.textColor'),
        backgroundColor:
            config.get('theme.light.skippedRange.backgroundColor'),
      },
      dark: {
        color: config.get('theme.dark.skippedRange.textColor'),
        backgroundColor:
            config.get('theme.dark.skippedRange.backgroundColor'),
      }
    });
    languageClient.onReady().then(() => {
      languageClient.onNotification('$ccls/setSkippedRanges', (args) => {
        let uri = args.uri;
        let ranges: Range[] = args.skippedRanges.map(p2c.asRange);
        for (const textEditor of window.visibleTextEditors) {
          if (textEditor.document.uri.toString() == uri) {
            window.activeTextEditor.setDecorations(
                skippedRangeDecorationType, ranges);
            break;
          }
        }
      });
    });
  })();

  // Progress
  (() => {
    let config = workspace.getConfiguration('ccls');
    let statusStyle = config.get('misc.status');
    if (statusStyle == 'short' || statusStyle == 'detailed') {
      let statusIcon = window.createStatusBarItem(StatusBarAlignment.Right);
      statusIcon.text = 'ccls: loading';
      statusIcon.tooltip =
          'ccls is loading project metadata (ie, compile_commands.json)';
      statusIcon.show();
      languageClient.onReady().then(() => {
        languageClient.onNotification('$ccls/progress', (args) => {
          let indexRequestCount = args.indexRequestCount || 0;
          let doIdMapCount = args.doIdMapCount || 0;
          let loadPreviousIndexCount = args.loadPreviousIndexCount || 0;
          let onIdMappedCount = args.onIdMappedCount || 0;
          let onIndexedCount = args.onIndexedCount || 0;
          let activeThreads = args.activeThreads || 0;
          let total = indexRequestCount + doIdMapCount +
              loadPreviousIndexCount + onIdMappedCount + onIndexedCount +
              activeThreads;

          let detailedJobString = `indexRequest: ${indexRequestCount}, ` +
              `doIdMap: ${doIdMapCount}, ` +
              `loadPreviousIndex: ${loadPreviousIndexCount}, ` +
              `onIdMapped: ${onIdMappedCount}, ` +
              `onIndexed: ${onIndexedCount}, ` +
              `activeThreads: ${activeThreads}`;

          if (total == 0 && statusStyle == 'short') {
            statusIcon.text = 'ccls: idle';
          } else {
            statusIcon.text = `ccls: ${indexRequestCount}|${total} jobs`;
            if (statusStyle == 'detailed') {
              statusIcon.text += ` (${detailedJobString})`
            }
          }
          statusIcon.tooltip = 'ccls jobs: ' + detailedJobString;
        });
      });
    }
  })();

  // QueryDb busy
  (() => {
    // Notifications have a minimum time to live. If the status changes multiple
    // times within that interface, we will show multiple notifications. Try to
    // avoid that.
    const kGracePeriodMs = 250;

    var timeout: NodeJS.Timer
    var resolvePromise: any
    languageClient.onReady().then(() => {
      languageClient.onNotification('$ccls/queryDbStatus', (args) => {
        let isActive: boolean = args.isActive;
        if (isActive) {
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          else {
            window.withProgress({location: ProgressLocation.Notification, title: 'querydb is busy'}, (p) => {
              p.report({increment: 100})
              return new Promise((resolve, reject) => {
                resolvePromise = resolve;
              });
            });
          }
        } else if (resolvePromise) {
          timeout = setTimeout(() => {
            resolvePromise();
            resolvePromise = undefined;
            timeout = undefined;
          }, kGracePeriodMs);
        }
      });
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

          let position = editor.selection.active;
          let uri = editor.document.uri;
          languageClient
              .sendRequest('$ccls/inheritanceHierarchy', {
                textDocument: {
                  uri: uri.toString(),
                },
                position: position,
                derived: true,
                detailedName: false,
                levels: 1
              })
              .then((entry: InheritanceHierarchyNode) => {
                InheritanceHierarchyNode.setWantsDerived(entry, true);

                languageClient
                    .sendRequest('$ccls/inheritanceHierarchy', {
                      id: entry.id,
                      kind: entry.kind,
                      derived: false,
                      detailedName: false,
                      levels: 1
                    })
                    .then((parentEntry: InheritanceHierarchyNode) => {
                      if (parentEntry.numChildren > 0) {
                        let parentWrapper = new InheritanceHierarchyNode();
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
              })
        });
    commands.registerCommand('ccls.closeInheritanceHierarchy', () => {
      setContext('extension.ccls.inheritanceHierarchyVisible', false);
      inheritanceHierarchyProvider.root = undefined;
      inheritanceHierarchyProvider.onDidChangeEmitter.fire();
    });
  })();

  // Call Hierarchy
  (() => {
    let derivedDark =
        context.asAbsolutePath(path.join('resources', 'derived-dark.svg'));
    let derivedLight =
        context.asAbsolutePath(path.join('resources', 'derived-light.svg'));
    let baseDark =
        context.asAbsolutePath(path.join('resources', 'base-dark.svg'));
    let baseLight =
        context.asAbsolutePath(path.join('resources', 'base-light.svg'));
    const callHierarchyProvider = new CallHierarchyProvider(
        languageClient, derivedDark, derivedLight, baseDark, baseLight);
    window.registerTreeDataProvider(
        'ccls.callHierarchy', callHierarchyProvider);
    commands.registerTextEditorCommand('ccls.callHierarchy', (editor) => {
      setContext('extension.ccls.callHierarchyVisible', true);
      let position = editor.selection.active;
      let uri = editor.document.uri;
      languageClient
          .sendRequest('$ccls/callHierarchy', {
            textDocument: {
              uri: uri.toString(),
            },
            position: position,
            callee: false,
            callType: 0x1 | 0x2,
            detailedName: false,
            levels: 2
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

  // Common between tree views.
  (() => {
    commands.registerCommand(
        'ccls.gotoForTreeView',
        (node: InheritanceHierarchyNode|CallHierarchyNode) => {
          if (!node.location)
            return;

          let parsedUri = parseUri(node.location.uri);
          let parsedPosition = p2c.asPosition(node.location.range.start);

          jumpToUriAtPosition(parsedUri, parsedPosition, true /*preserveFocus*/)
        });

    let lastGotoNodeId: any
    let lastGotoClickTime: number
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

          if (lastGotoNodeId != node.id) {
            lastGotoNodeId = node.id;
            lastGotoClickTime = Date.now();
            return;
          }

          let config = workspace.getConfiguration('ccls');
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
      let opts: any = {};
      opts.rangeBehavior = DecorationRangeBehavior.ClosedClosed;
      opts.color = color;
      if (underline == true)
        opts.textDecoration = 'underline';
      if (italic == true)
        opts.fontStyle = 'italic';
      if (bold == true)
        opts.fontWeight = 'bold';
      return window.createTextEditorDecorationType(
          <DecorationRenderOptions>opts);
    };

    function makeDecorations(type: string) {
      let config = workspace.getConfiguration('ccls');
      let colors = config.get(`highlighting.colors.${type}`, []);
      let u = config.get(`highlighting.underline.${type}`, false);
      let i = config.get(`highlighting.italic.${type}`, false);
      let b = config.get(`highlighting.bold.${type}`, false);
      return colors.map(c => makeSemanticDecorationType(c, u, i, b));
    };
    let semanticDecorations = new Map<string, TextEditorDecorationType[]>();
    let semanticEnabled = new Map<string, boolean>();
    for (let type of
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
      let config = workspace.getConfiguration('ccls');
      for (let [name, value] of semanticEnabled) {
        semanticEnabled.set(
            name, config.get(`highlighting.enabled.${name}`, false));
      }
    };
    updateConfigValues();

    function tryFindDecoration(symbol: SemanticSymbol):
        Nullable<TextEditorDecorationType> {
      function get(name: string) {
        if (!semanticEnabled.get(name))
          return undefined;
        let decorations = semanticDecorations.get(name);
        return decorations[symbol.stableId % decorations.length];
      };

      if (symbol.kind == SymbolKind.Class || symbol.kind == SymbolKind.Struct) {
        return get('types');
      } else if (symbol.kind == SymbolKind.Enum) {
        return get('enums');
      } else if (symbol.kind == SymbolKind.TypeAlias) {
        return get('typeAliases');
      } else if (symbol.kind == SymbolKind.TypeParameter) {
        return get('templateParameters');
      } else if (symbol.kind == SymbolKind.Function) {
        return get('freeStandingFunctions');
      } else if (
          symbol.kind == SymbolKind.Method ||
          symbol.kind == SymbolKind.Constructor) {
        return get('memberFunctions')
      } else if (symbol.kind == SymbolKind.StaticMethod) {
        return get('staticMemberFunctions')
      } else if (symbol.kind == SymbolKind.Variable) {
        if (symbol.parentKind == SymbolKind.Function ||
            symbol.parentKind == SymbolKind.Method ||
            symbol.parentKind == SymbolKind.Constructor) {
          return get('freeStandingVariables');
        }
        return get('globalVariables');
      } else if (symbol.kind == SymbolKind.Field) {
        if (symbol.storage == StorageClass.Static) {
          return get('staticMemberVariables');
        }
        return get('memberVariables');
      } else if (symbol.kind == SymbolKind.Parameter) {
        return get('parameters');
      } else if (symbol.kind == SymbolKind.EnumMember) {
        return get('enumConstants');
      } else if (symbol.kind == SymbolKind.Namespace) {
        return get('namespaces');
      } else if (symbol.kind == SymbolKind.Macro) {
        return get('macros');
      }
    };

    class PublishSemanticHighlightingArgs {
      readonly uri: string;
      readonly symbols: SemanticSymbol[];
    }
    languageClient.onReady().then(() => {
      languageClient.onNotification(
          '$ccls/publishSemanticHighlighting',
          (args: PublishSemanticHighlightingArgs) => {
            updateConfigValues();

            for (let visibleEditor of window.visibleTextEditors) {
              if (args.uri != visibleEditor.document.uri.toString())
                continue;

              let decorations =
                  new Map<TextEditorDecorationType, Array<Range>>();

              for (let symbol of args.symbols) {
                let type = tryFindDecoration(symbol);
                if (!type)
                  continue;
                if (decorations.has(type)) {
                  let existing = decorations.get(type);
                  for (let range of symbol.lsRanges)
                    existing.push(range);
                } else {
                  decorations.set(type, symbol.lsRanges);
                }
              }

              // Clear decorations and set new ones. We might not use all of the
              // decorations so clear before setting.
              for (let [_, decorations] of semanticDecorations) {
                decorations.forEach((type) => {
                  visibleEditor.setDecorations(type, []);
                });
              }
              // Set new decorations.
              decorations.forEach((ranges, type) => {
                visibleEditor.setDecorations(type, ranges);
              });
            }
          });
    });
  })();

  // Send $ccls/textDocumentDidView. Always send a notification - this will
  // result in some extra work, but it shouldn't be a problem in practice.
  (() => {
    window.onDidChangeVisibleTextEditors(visible => {
      for (let editor of visible) {
        languageClient.sendNotification(
            '$ccls/textDocumentDidView',
            {textDocumentUri: editor.document.uri.toString()});
      }
    });
  })();
}
