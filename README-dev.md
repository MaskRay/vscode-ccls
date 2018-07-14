# ccls

This is the Visual Studio Code extension for ccls, which is a rewrite of cquery.
This repository is just a rename of vscode-cquery.

The main ccls language server which powers this extension is found at
[https://github.com/cquery-project/ccls](https://github.com/cquery-project/cquery).

# Building

## Dependencies

Make sure you have `npm` installed.

## Build

```bash
npm install
python build.py
```

Now, you can use vscode to install `out/ccls.vsix`.

# Deploying

To deploy a new release to the marketplace, simply run `publish.py` with a
clean working directory. By default a patch release is performed.

```bash
python publish.py [patch|minor|major]
```

# LICENSE

MIT
