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
- **Enter**: Upload file / view details
- **b**: Set batch ID
- **q**: Quit

Set `SWARM_BATCH_ID` env var or press `b` to configure your postage batch.

