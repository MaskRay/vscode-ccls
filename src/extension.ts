import * as path from 'path';
import {CodeLens, commands, DecorationOptions, DecorationRangeBehavior, DecorationRenderOptions, ExtensionContext, OverviewRulerLane, Position, Progress, ProgressLocation, ProviderResult, QuickPickItem, Range, StatusBarAlignment, TextDocument, TextEditor, TextEditorDecorationType, ThemeColor, Uri, window, workspace} from 'vscode';
import {Message} from 'vscode-jsonrpc';
import {CancellationToken, LanguageClient, LanguageClientOptions, Middleware, ProvideCodeLensesSignature, RevealOutputChannelOn, ServerOptions} from 'vscode-languageclient/lib/main';
import * as ls from 'vscode-languageserver-types';

import {CallHierarchyNode, CallHierarchyProvider} from './callHierarchy';
import {CqueryErrorHandler} from './cqueryErrorHandler';
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

  // cquery extensions
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
      readonly storage: StorageClass, readonly ranges: Array<Range>) {}
}

function getClientConfig(context: ExtensionContext) {
  const kCacheDirPrefName = 'cacheDirectory';

  function hasAnySemanticHighlighting() {
    let options = [
      'cquery.highlighting.enabled.types',
      'cquery.highlighting.enabled.freeStandingFunctions',
      'cquery.highlighting.enabled.memberFunctions',
      'cquery.highlighting.enabled.freeStandingVariables',
      'cquery.highlighting.enabled.memberVariables',
      'cquery.highlighting.enabled.namespaces',
      'cquery.highlighting.enabled.macros',
      'cquery.highlighting.enabled.enums',
      'cquery.highlighting.enabled.typeAliases',
      'cquery.highlighting.enabled.enumConstants',
      'cquery.highlighting.enabled.staticMemberFunctions',
      'cquery.highlighting.enabled.parameters',
      'cquery.highlighting.enabled.templateParameters',
      'cquery.highlighting.enabled.staticMemberVariables',
      'cquery.highlighting.enabled.globalVariables'];
    let config = workspace.getConfiguration();
    for (let name of options) {
      if (config.get(name, false))
        return true;
    }
    return false;
  }

  // Read prefs; this map goes from `cquery/js name` => `vscode prefs name`.
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
    ['misc.discoverSystemIncludes','discoverSystemIncludes'],
    ['formatting.enabled', 'formatting.enabled'],
  ];
  let clientConfig = {
    launchCommand: '',
    cacheDirectory: '',
    highlight: {
      enabled: hasAnySemanticHighlighting()
    },
    workspaceSymbol: {
      sort: false,
    },
  };
  let config = workspace.getConfiguration('cquery');
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
      subconfig[subprops[subprops.length - 1]] = value;
    }
  }

  // Set up a cache directory if there is not one.
  if (!clientConfig.cacheDirectory) {
    if (!context.storagePath) {
      const kOpenSettings = 'Open Settings';
      window
          .showErrorMessage(
              'Could not auto-discover cache directory. Please use "Open Folder" ' +
                  'or specify it in the |cquery.cacheDirectory| setting.',
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
    let cacheDir = '${workspaceFolder}/.vscode/cquery_cached_index/';
    clientConfig.cacheDirectory = cacheDir;
    config.update(kCacheDirPrefName, cacheDir, false /*global*/);
  }
  clientConfig.cacheDirectory = clientConfig.cacheDirectory.replace(
      '${workspaceFolder}', workspace.rootPath);

  return clientConfig;
}



export function activate(context: ExtensionContext) {
  /////////////////////////////////////
  // Setup configuration, start server.
  /////////////////////////////////////

  // Load configuration and start the client.
  let languageClient = (() => {
    let clientConfig = getClientConfig(context);
    if (!clientConfig)
      return;
    // Notify the user that if they change a cquery setting they need to restart
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
          const message = `Please reload to apply the "cquery.${
              key}" configuration change.`;

          window.showInformationMessage(message, kReload).then(selected => {
            if (selected == kReload)
              commands.executeCommand('workbench.action.reloadWindow');
          });
          break;
        }
      }
    }));

    let args = ['--language-server'].concat(clientConfig['launchArgs']);

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
    let decorationOpts: any = {};
    decorationOpts.rangeBehavior = DecorationRangeBehavior.ClosedClosed;
    decorationOpts.color = new ThemeColor('editorCodeLens.foreground');
    decorationOpts.fontStyle = 'italic';
    let codeLensDecoration = window.createTextEditorDecorationType(
        <DecorationRenderOptions>decorationOpts);

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
      let config = workspace.getConfiguration('cquery');
      let enableInlineCodeLens = config.get('codeLens.renderInline', false);
      if (!enableInlineCodeLens)
        return next(document, token);

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
      // 	configurationSection: 'cquery',
      // 	fileEvents: workspace.createFileSystemWatcher('**/.cc')
      // },
      diagnosticCollectionName: 'cquery',
      outputChannelName: 'cquery',
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      initializationOptions: clientConfig,
      middleware: {provideCodeLenses: provideCodeLens},
      initializationFailedHandler: (e) => {
        console.log(e);
        return false;
      },
      errorHandler: new CqueryErrorHandler(workspace.getConfiguration('cquery'))
    }

    // Create the language client and start the client.
    let languageClient =
        new LanguageClient('cquery', 'cquery', serverOptions, clientOptions);
    let command = serverOptions.command
    languageClient.onReady().catch(e => {
      // TODO: remove cquery.launch.workingDirectory after July 2018
      window.showErrorMessage(
          'cquery.launch.command has changed; either add cquery to your PATH ' +
          'or make cquery.launch.command an absolute path. Current value: "' +
          command + '". cquery.launch.workingDirectory has been removed.');
    });
    context.subscriptions.push(languageClient.start());

    return languageClient;
  })();

  let p2c = languageClient.protocol2CodeConverter;

  // General commands.
  (() => {
    commands.registerCommand('cquery.freshenIndex', () => {
      languageClient.sendNotification('$cquery/freshenIndex');
    });

    function makeRefHandler(methodName, autoGotoIfSingle = false) {
      return () => {
        let position = window.activeTextEditor.selection.active;
        let uri = window.activeTextEditor.document.uri;
        languageClient
            .sendRequest(methodName, {
              textDocument: {
                uri: uri.toString(),
              },
              position: position
            })
            .then((locations: Array<ls.Location>) => {
              if (autoGotoIfSingle && locations.length == 1) {
                let location = p2c.asLocation(locations[0]);
                commands.executeCommand(
                    'cquery.goto', location.uri, location.range.start, []);
              } else {
                commands.executeCommand(
                    'editor.action.showReferences', uri, position,
                    locations.map(p2c.asLocation));
              }
            })
      }
    }
    commands.registerCommand('cquery.vars', makeRefHandler('$cquery/vars'));
    commands.registerCommand(
        'cquery.callers', makeRefHandler('$cquery/callers'));
    commands.registerCommand(
        'cquery.base', makeRefHandler('$cquery/base', true));
  })();

  // The language client does not correctly deserialize arguments, so we have a
  // wrapper command that does it for us.
  (() => {
    commands.registerCommand(
        'cquery.showReferences',
        (uri: string, position: ls.Position, locations: ls.Location[]) => {
          commands.executeCommand(
              'editor.action.showReferences', p2c.asUri(uri),
              p2c.asPosition(position), locations.map(p2c.asLocation));
        });


    commands.registerCommand(
        'cquery.goto',
        (uri: string, position: ls.Position, locations: ls.Location[]) => {
          jumpToUriAtPosition(
              p2c.asUri(uri), p2c.asPosition(position),
              false /*preserveFocus*/);
        });
  })();

  // FixIt support
  (() => {
    commands.registerCommand('cquery._applyFixIt', (uri, pTextEdits) => {
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
    commands.registerCommand('cquery._autoImplement', (uri, pTextEdits) => {
      commands.executeCommand('cquery._applyFixIt', uri, pTextEdits)
          .then(() => {
            commands.executeCommand(
                'cquery.goto', uri, pTextEdits[0].range.start);
          });
    });
  })();

  // Insert include.
  (() => {
    commands.registerCommand('cquery._insertInclude', (uri, pTextEdits) => {
      if (pTextEdits.length == 1)
        commands.executeCommand('cquery._applyFixIt', uri, pTextEdits);
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
          commands.executeCommand('cquery._applyFixIt', uri, [selected.edit]);
        });
      }
    });
  })();

  // Inactive regions.
  (() => {
    let config = workspace.getConfiguration('cquery');
    const inactiveRegionDecorationType = window.createTextEditorDecorationType({
      isWholeLine: true,
      light: {
        color: config.get('theme.light.inactiveRegion.textColor'),
        backgroundColor:
            config.get('theme.light.inactiveRegion.backgroundColor'),
      },
      dark: {
        color: config.get('theme.dark.inactiveRegion.textColor'),
        backgroundColor:
            config.get('theme.dark.inactiveRegion.backgroundColor'),
      }
    });
    languageClient.onReady().then(() => {
      languageClient.onNotification('$cquery/setInactiveRegions', (args) => {
        let uri = args.uri;
        let ranges: Range[] = args.inactiveRegions.map(p2c.asRange);
        for (const textEditor of window.visibleTextEditors) {
          if (textEditor.document.uri.toString() == uri) {
            window.activeTextEditor.setDecorations(
                inactiveRegionDecorationType, ranges);
            break;
          }
        }
      });
    });
  })();

  // Progress
  (() => {
    let config = workspace.getConfiguration('cquery');
    let statusStyle = config.get('misc.status');
    if (statusStyle == 'short' || statusStyle == 'detailed') {
      let statusIcon = window.createStatusBarItem(StatusBarAlignment.Right);
      statusIcon.text = 'cquery: loading';
      statusIcon.tooltip =
          'cquery is loading project metadata (ie, compile_commands.json)';
      statusIcon.show();
      languageClient.onReady().then(() => {
        languageClient.onNotification('$cquery/progress', (args) => {
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
            statusIcon.text = 'cquery: idle';
          } else {
            statusIcon.text = `cquery: ${indexRequestCount}|${total} jobs`;
            if (statusStyle == 'detailed') {
              statusIcon.text += ` (${detailedJobString})`
            }
          }
          statusIcon.tooltip = 'cquery jobs: ' + detailedJobString;
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
      languageClient.onNotification('$cquery/queryDbStatus', (args) => {
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
        'cquery.inheritanceHierarchy', inheritanceHierarchyProvider);
    commands.registerTextEditorCommand(
        'cquery.inheritanceHierarchy', (editor) => {
          setContext('extension.cquery.inheritanceHierarchyVisible', true);

          let position = editor.selection.active;
          let uri = editor.document.uri;
          languageClient
              .sendRequest('$cquery/inheritanceHierarchy', {
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
                    .sendRequest('$cquery/inheritanceHierarchy', {
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
    commands.registerCommand('cquery.closeInheritanceHierarchy', () => {
      setContext('extension.cquery.inheritanceHierarchyVisible', false);
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
        'cquery.callHierarchy', callHierarchyProvider);
    commands.registerTextEditorCommand('cquery.callHierarchy', (editor) => {
      setContext('extension.cquery.callHierarchyVisible', true);
      let position = editor.selection.active;
      let uri = editor.document.uri;
      languageClient
          .sendRequest('$cquery/callHierarchy', {
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
    commands.registerCommand('cquery.closeCallHierarchy', (e) => {
      setContext('extension.cquery.callHierarchyVisible', false);
      callHierarchyProvider.root = undefined;
      callHierarchyProvider.onDidChangeEmitter.fire();
    });
  })();

  // Common between tree views.
  (() => {
    commands.registerCommand(
        'cquery.gotoForTreeView',
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
        'cquery.hackGotoForTreeView',
        (node: InheritanceHierarchyNode|CallHierarchyNode,
         hasChildren: boolean) => {
          if (!node.location)
            return;

          if (!hasChildren) {
            commands.executeCommand('cquery.gotoForTreeView', node);
            return;
          }

          if (lastGotoNodeId != node.id) {
            lastGotoNodeId = node.id;
            lastGotoClickTime = Date.now();
            return;
          }

          let config = workspace.getConfiguration('cquery');
          const kDoubleClickTimeMs =
              config.get('treeViews.doubleClickTimeoutMs');
          const elapsed = Date.now() - lastGotoClickTime;
          lastGotoClickTime = Date.now();
          if (elapsed < kDoubleClickTimeMs)
            commands.executeCommand('cquery.gotoForTreeView', node);
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
      let config = workspace.getConfiguration('cquery');
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
      let config = workspace.getConfiguration('cquery');
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
          '$cquery/publishSemanticHighlighting',
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
                  for (let range of symbol.ranges)
                    existing.push(range);
                } else {
                  decorations.set(type, symbol.ranges);
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

  // Send $cquery/textDocumentDidView. Always send a notification - this will
  // result in some extra work, but it shouldn't be a problem in practice.
  (() => {
    window.onDidChangeVisibleTextEditors(visible => {
      for (let editor of visible) {
        languageClient.sendNotification(
            '$cquery/textDocumentDidView',
            {textDocumentUri: editor.document.uri.toString()});
      }
    });
  })();
}
