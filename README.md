# cquery

This is the Visual Studio Code extension for cquery. The main cquery language
server which powers this extension is found at
[https://github.com/jacobdufault/cquery](https://github.com/jacobdufault/cquery).

# Building

## Dependencies

Make sure you have `npm` installed.

## Build

```bash
npm install
python build.py
```

Now, you can use vscode to install `out/cquery.vsix`.

# Deploying

To deploy a new release to the marketplace, simply run `publish.py` with a
clean working directory. By default a patch release is performed.

```bash
python publish.py [patch|minor|major]
```

# LICENSE

MIT
