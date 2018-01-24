# cquery

This is the Visual Studio Code extension for cquery. The main cquery language
server which powers this extension is found at
[https://github.com/jacobdufault/cquery](https://github.com/jacobdufault/cquery).

# Building

## Dependencies

Make sure you have `vsce` and `npm` installed.

```bash
npm install -g vsce
```

## Build

```bash
npm install
python build.py
```

Now, you can use vscode to install `out/cquery.vsix`.

# LICENSE

MIT