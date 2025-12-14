# swarm-commander

Midnight Commander-style TUI for uploading files to Swarm.

## Requirements

- Node.js
- Running [Bee](https://docs.ethswarm.org/docs/bee/installation/quick-start) node on `127.0.0.1:1633`
- Valid postage batch ID

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Or install globally:

```bash
npm install -g .
swarm-commander
```

## Usage

- **Left panel**: File browser
- **Right panel**: Upload queue & sync status
- **Tab**: Switch panels
- **Enter**: Navigate directories / view upload details
- **F5**: Upload selected file or directory
- **F2**: Set batch ID
- **q/F10**: Quit

### Directory Uploads

Directories are uploaded with a manifest, allowing you to access individual files via their paths. Select a directory and press F5 to upload. The directory will be packaged as a tar archive and uploaded to Swarm with collection support.

### Viewing Manifest Files

After uploading a directory, you can view its contents:
1. Switch to the Uploads panel (Tab)
2. Select an upload and press Enter to view details
3. Press **L** to list all files in the manifest

Set `SWARM_BATCH_ID` env var or press F2 to configure your postage batch.

