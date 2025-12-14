#!/usr/bin/env node
import blessed from 'neo-blessed';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { homedir } from 'os';

// State directory (relative to script location)
const stateDir = path.join(path.dirname(process.argv[1]) || '.', 'state');
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

// Config
const configPath = path.join(stateDir, 'config.json');
const uploadsDbPath = path.join(stateDir, 'uploads.json');

// Migration from old locations
const oldPaths = [
  { from: path.join(homedir(), '.swarm-commander.json'), to: configPath },
  { from: path.join(homedir(), '.swarm-commander-uploads.json'), to: uploadsDbPath },
  { from: path.join(homedir(), '.swarm-uploader.json'), to: configPath },
  { from: path.join(homedir(), '.swarm-uploader-uploads.json'), to: uploadsDbPath },
];

function migrateOldConfig() {
  for (const { from, to } of oldPaths) {
    try {
      if (!fs.existsSync(to) && fs.existsSync(from)) {
        fs.copyFileSync(from, to);
      }
    } catch {}
  }
}

migrateOldConfig();

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {}
}

function loadUploadsDb() {
  try {
    if (fs.existsSync(uploadsDbPath)) {
      return JSON.parse(fs.readFileSync(uploadsDbPath, 'utf8'));
    }
  } catch {}
  return {};
}

function saveUploadMeta(tagUid, meta) {
  const db = loadUploadsDb();
  db[tagUid] = { ...db[tagUid], ...meta };
  try {
    fs.writeFileSync(uploadsDbPath, JSON.stringify(db, null, 2));
  } catch {}
}

function getUploadMeta(tagUid) {
  const db = loadUploadsDb();
  return db[tagUid] || null;
}

// State
const config = loadConfig();
let currentDir = process.cwd();
let batchId = process.env.SWARM_BATCH_ID || config.batchId || '';
let selectedUploadDetail = null;

// HTTP helper
function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data.trim() });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function createTag() {
  const result = await httpRequest({
    hostname: '127.0.0.1',
    port: 1633,
    path: '/tags',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return result.uid;
}

async function getTagStatus(tagUid) {
  return await httpRequest({
    hostname: '127.0.0.1',
    port: 1633,
    path: `/tags/${tagUid}`,
    method: 'GET',
  });
}

async function getAllTags() {
  const allTags = [];
  let offset = 0;
  const limit = 1000;
  
  while (true) {
    const result = await httpRequest({
      hostname: '127.0.0.1',
      port: 1633,
      path: `/tags?limit=${limit}&offset=${offset}`,
      method: 'GET',
    });
    
    const tags = result.tags || [];
    allTags.push(...tags);
    
    if (tags.length < limit) {
      break; // No more tags
    }
    offset += limit;
  }
  
  return allTags;
}

// Create screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'Swarm Commander',
  fullUnicode: true,
});

// Color scheme - Midnight Commander inspired
const colors = {
  bg: 'black',
  fg: 'white',
  border: 'cyan',
  selected: 'blue',
  header: 'yellow',
  directory: 'white',
  file: 'gray',
  uploaded: 'green',
  error: 'red',
};

// Header
const header = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: 1,
  content: ' {bold}SWARM COMMANDER{/bold}  │  F2: Batch  │  F5: Upload  │  F10/Q: Quit  │  Tab: Switch  ',
  tags: true,
  style: {
    fg: 'black',
    bg: 'cyan',
  },
});

// Left panel - File browser
const leftBox = blessed.box({
  parent: screen,
  top: 1,
  left: 0,
  width: '50%',
  height: '100%-3',
  label: ' {cyan-fg}Files{/cyan-fg} ',
  tags: true,
  border: { type: 'line' },
  style: {
    border: { fg: colors.border },
    bg: colors.bg,
  },
});

const leftHeader = blessed.box({
  parent: leftBox,
  top: 0,
  left: 0,
  width: '100%-2',
  height: 1,
  tags: true,
  style: { fg: 'yellow', bg: 'blue' },
});

const fileList = blessed.list({
  parent: leftBox,
  top: 1,
  left: 0,
  width: '100%-2',
  height: '100%-3',
  keys: true,
  vi: true,
  mouse: true,
  scrollbar: {
    ch: '|',
    style: { bg: 'cyan' },
  },
  style: {
    fg: colors.fg,
    bg: colors.bg,
    selected: { fg: 'black', bg: 'cyan', bold: true },
  },
});

// Right panel - Uploads
const rightBox = blessed.box({
  parent: screen,
  top: 1,
  left: '50%',
  width: '50%',
  height: '100%-3',
  label: ' {green-fg}Uploads{/green-fg} ',
  tags: true,
  border: { type: 'line' },
  style: {
    border: { fg: colors.border },
    bg: colors.bg,
  },
});

const rightHeader = blessed.box({
  parent: rightBox,
  top: 0,
  left: 0,
  width: '100%-2',
  height: 1,
  content: ' Name                 Sync   Progress',
  style: { fg: 'yellow', bg: 'blue' },
});

const tagList = blessed.list({
  parent: rightBox,
  top: 1,
  left: 0,
  width: '100%-2',
  height: '100%-3',
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  scrollbar: {
    ch: '|',
    style: { bg: 'green' },
  },
  style: {
    fg: colors.fg,
    bg: colors.bg,
    selected: { fg: 'black', bg: 'green', bold: true },
  },
});

const nodeErrorBox = blessed.box({
  parent: rightBox,
  top: 'center',
  left: 'center',
  width: 'shrink',
  height: 'shrink',
  padding: { left: 2, right: 2, top: 1, bottom: 1 },
  tags: true,
  hidden: true,
  style: { fg: 'red', bg: 'black', border: { fg: 'red' } },
  border: { type: 'line' },
  content: '{bold}Swarm node unreachable{/bold}\n\n{gray-fg}Check if bee is running on 127.0.0.1:1633{/gray-fg}',
});

// Footer / Status bar
const footer = blessed.box({
  parent: screen,
  bottom: 1,
  left: 0,
  width: '100%',
  height: 1,
  tags: true,
  style: { fg: 'black', bg: 'cyan' },
});

// Batch ID input area
const batchBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 1,
  tags: true,
  style: { fg: 'white', bg: 'black' },
});

// Active panel tracking
let activePanel = 'left';

function updateBatchBar() {
  const batchDisplay = batchId ? `{green-fg}${batchId.slice(0, 32)}...{/green-fg}` : '{red-fg}NOT SET (press F2){/red-fg}';
  batchBar.setContent(` Batch: ${batchDisplay}`);
}

function getFileIcon(entry) {
  if (entry.isDir) return '[D]';
  const ext = path.extname(entry.name).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(ext)) return '[I]';
  if (['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a'].includes(ext)) return '[A]';
  if (['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv'].includes(ext)) return '[V]';
  if (['.js', '.ts', '.py', '.rs', '.go', '.c', '.cpp', '.h', '.java', '.rb', '.sh'].includes(ext)) return '[C]';
  if (['.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.conf'].includes(ext)) return '[~]';
  if (['.md', '.txt', '.doc', '.docx', '.pdf', '.rtf'].includes(ext)) return '[T]';
  if (['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz'].includes(ext)) return '[Z]';
  return '   ';
}

function formatSize(bytes) {
  if (bytes === 0) return '     0 B';
  const k = 1024;
  const sizes = ['B', 'K', 'M', 'G', 'T'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0);
  return size.padStart(6) + ' ' + sizes[i];
}

function formatSizeHuman(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function createProgressBar(percent, width = 30) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function loadDirectory(dir) {
  try {
    currentDir = path.resolve(dir);
    const entries = [];
    
    // Add parent directory entry
    if (currentDir !== '/') {
      entries.push({ name: '..', isDir: true, size: 0 });
    }
    
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    
    // Sort: directories first, then files, alphabetically
    const dirs = items.filter(i => i.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = items.filter(i => i.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    
    for (const item of [...dirs, ...files]) {
      try {
        const fullPath = path.join(currentDir, item.name);
        const stat = fs.statSync(fullPath);
        entries.push({
          name: item.name,
          isDir: item.isDirectory(),
          size: stat.size,
          path: fullPath,
        });
      } catch {
        // Skip files we can't stat
      }
    }
    
    // Update header with current path
    const displayPath = currentDir.replace(homedir(), '~');
    leftHeader.setContent(` ${displayPath}`);
    
    // Build list items
    const listItems = entries.map(e => {
      const icon = getFileIcon(e);
      const size = e.isDir ? '  <DIR>' : formatSize(e.size);
      const maxNameLen = 28;
      const name = e.name.length > maxNameLen ? e.name.slice(0, maxNameLen - 3) + '...' : e.name.padEnd(maxNameLen);
      return `${icon} ${name} ${size}`;
    });
    
    fileList.setItems(listItems);
    fileList.entries = entries;
    fileList.select(0);
    
    updateFooter();
    screen.render();
  } catch (err) {
    showMessage(`Error: ${err.message}`, 'error');
  }
}

function updateFooter() {
  const selected = fileList.entries?.[fileList.selected];
  if (selected) {
    const info = selected.isDir ? 'Directory' : `File: ${formatSize(selected.size).trim()}`;
    footer.setContent(` ${selected.name}  │  ${info}  │  ${fileList.entries.length - 1} items`);
  }
}

async function refreshTagList() {
  try {
    const tags = await getAllTags();
    // Sort by uid descending (newest first)
    tags.sort((a, b) => b.uid - a.uid);
    
    const items = tags.map(tag => {
      const meta = getUploadMeta(tag.uid);
      const name = meta?.name ? meta.name.slice(0, 20).padEnd(20) : '(unknown)'.padEnd(20);
      const percent = tag.split > 0 ? Math.round((tag.synced / tag.split) * 100) : 0;
      const progress = `${String(percent).padStart(3)}%`;
      
      // Color the row based on status
      let color = '';
      let endColor = '';
      if (tag.split === 0) {
        color = '{gray-fg}';
        endColor = '{/gray-fg}';
      } else if (tag.synced >= tag.split) {
        color = '{green-fg}';
        endColor = '{/green-fg}';
      } else if (tag.sent > 0 || tag.synced > 0) {
        color = '{cyan-fg}';
        endColor = '{/cyan-fg}';
      } else if (tag.seen > 0 || tag.stored > 0) {
        color = '{yellow-fg}';
        endColor = '{/yellow-fg}';
      }
      
      return `${color}${name} ${progress} ${tag.synced}/${tag.split}${endColor}`;
    });
    
    const prevSelected = tagList.selected;
    const prevScroll = tagList.childBase;
    tagList.setItems(items);
    tagList.tags = tags;
    tagList.select(Math.min(prevSelected, items.length - 1));
    tagList.childBase = Math.min(prevScroll, Math.max(0, items.length - tagList.height + 2));
    nodeErrorBox.hide();
    screen.render();
  } catch (err) {
    nodeErrorBox.show();
    screen.render();
  }
}

function showUploadDetail(tag) {
  const meta = getUploadMeta(tag.uid);
  
  // Clear existing detail view
  if (selectedUploadDetail) {
    selectedUploadDetail.destroy();
  }
  
  const percent = tag.split > 0 ? Math.round((tag.synced / tag.split) * 100) : 0;
  const progressBar = createProgressBar(percent, 25);
  
  const detailBox = blessed.box({
    parent: rightBox,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-2',
    tags: true,
    style: { fg: 'white', bg: 'black' },
    content: 
      `{bold}{cyan-fg}Upload Details{/cyan-fg}{/bold}\n` +
      `${'─'.repeat(40)}\n\n` +
      `{bold}Name:{/bold}     ${meta?.name || '(unknown)'}\n\n` +
      `{bold}Hash:{/bold}     ${meta?.reference || '(pending)'}\n\n` +
      `{bold}Date:{/bold}     ${meta?.date || '(unknown)'}\n\n` +
      `{bold}Batch:{/bold}    ${meta?.batchId?.slice(0, 32) || '(unknown)'}...\n\n` +
      `{bold}Tag UID:{/bold}  ${tag.uid}\n\n` +
      `{bold}Progress:{/bold} {cyan-fg}${progressBar}{/cyan-fg} ${percent}%\n` +
      `           ${tag.synced} / ${tag.split} chunks synced\n\n` +
      `${'─'.repeat(40)}\n` +
      `{gray-fg}Press Escape to close{/gray-fg}`,
  });
  
  selectedUploadDetail = detailBox;
  screen.render();
}

function closeUploadDetail() {
  if (selectedUploadDetail) {
    selectedUploadDetail.destroy();
    selectedUploadDetail = null;
    screen.render();
  }
}

function showUploadConfirmation(filePath, fileSize, onConfirm) {
  const fileName = path.basename(filePath);
  
  const dialog = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 60,
    height: 12,
    border: 'line',
    label: ' {bold}Upload to Swarm{/bold} ',
    tags: true,
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: 'cyan' },
    },
  });
  
  blessed.box({
    parent: dialog,
    top: 1,
    left: 2,
    width: '100%-4',
    height: 6,
    tags: true,
    content: 
      `{bold}File:{/bold}  ${fileName}\n\n` +
      `{bold}Size:{/bold}  ${formatSizeHuman(fileSize)}\n\n` +
      `{bold}Name on Swarm:{/bold}  ${fileName}`,
    style: { fg: 'white', bg: 'black' },
  });
  
  const okBtn = blessed.button({
    parent: dialog,
    bottom: 1,
    left: 10,
    width: 12,
    height: 1,
    content: '   OK   ',
    style: {
      fg: 'black',
      bg: 'green',
      focus: { fg: 'black', bg: 'cyan' },
    },
    keys: true,
    mouse: true,
  });
  
  const cancelBtn = blessed.button({
    parent: dialog,
    bottom: 1,
    right: 10,
    width: 12,
    height: 1,
    content: ' Cancel ',
    style: {
      fg: 'black',
      bg: 'red',
      focus: { fg: 'black', bg: 'cyan' },
    },
    keys: true,
    mouse: true,
  });
  
  okBtn.focus();
  screen.render();
  
  const close = () => {
    dialog.destroy();
    fileList.focus();
    screen.render();
  };
  
  okBtn.on('press', () => { close(); onConfirm(); });
  cancelBtn.on('press', close);
  
  dialog.key(['escape'], close);
  dialog.key(['enter'], () => { close(); onConfirm(); });
  okBtn.key(['tab', 'right'], () => cancelBtn.focus());
  cancelBtn.key(['tab', 'left'], () => okBtn.focus());
}

async function uploadFile(filePath) {
  if (!batchId) {
    showMessage('Batch ID not set! Press F2 to set it.', 'error');
    return;
  }
  
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  
  // Create progress dialog (modal)
  const progressBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 60,
    height: 16,
    border: 'line',
    label: ' {bold}Uploading{/bold} ',
    tags: true,
    keys: true,
    vi: false,
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: 'yellow' },
    },
  });
  
  const statusLine = blessed.box({
    parent: progressBox,
    top: 1,
    left: 2,
    width: '100%-4',
    height: 1,
    tags: true,
    content: '{yellow-fg}Creating tag...{/yellow-fg}',
    style: { fg: 'white', bg: 'black' },
  });
  
  const fileInfo = blessed.box({
    parent: progressBox,
    top: 3,
    left: 2,
    width: '100%-4',
    height: 1,
    tags: true,
    content: `File: ${fileName.slice(0, 40)}`,
    style: { fg: 'gray', bg: 'black' },
  });
  
  const tagInfo = blessed.box({
    parent: progressBox,
    top: 4,
    left: 2,
    width: '100%-4',
    height: 1,
    tags: true,
    content: 'Tag UID: ...',
    style: { fg: 'gray', bg: 'black' },
  });
  
  const progressBar = blessed.box({
    parent: progressBox,
    top: 6,
    left: 2,
    width: '100%-4',
    height: 1,
    tags: true,
    content: '{cyan-fg}' + createProgressBar(0) + '{/cyan-fg}  0%',
    style: { fg: 'white', bg: 'black' },
  });
  
  const dataInfo = blessed.box({
    parent: progressBox,
    top: 7,
    left: 2,
    width: '100%-4',
    height: 1,
    tags: true,
    content: `0 B / ${formatSizeHuman(fileSize)}`,
    style: { fg: 'gray', bg: 'black' },
  });
  
  const phaseInfo = blessed.box({
    parent: progressBox,
    top: 9,
    left: 2,
    width: '100%-4',
    height: 1,
    tags: true,
    content: 'Phase: Initializing',
    style: { fg: 'white', bg: 'black' },
  });
  
  const bgButton = blessed.button({
    parent: progressBox,
    bottom: 1,
    left: 'center',
    width: 22,
    height: 1,
    content: ' Move to Background ',
    tags: true,
    keys: true,
    mouse: true,
    style: {
      fg: 'white',
      bg: 'blue',
      focus: { fg: 'black', bg: 'cyan' },
    },
  });
  
  // Make modal - grab focus
  progressBox.focus();
  screen.render();
  
  let tagUid = null;
  let progressInterval = null;
  let backgrounded = false;
  
  const updateProgress = (phase, percent, transferred = 0) => {
    if (backgrounded) return;
    const bar = createProgressBar(percent);
    progressBar.setContent(`{cyan-fg}${bar}{/cyan-fg} ${percent.toFixed(0).padStart(3)}%`);
    dataInfo.setContent(`${formatSizeHuman(transferred)} / ${formatSizeHuman(fileSize)}`);
    phaseInfo.setContent(`Phase: ${phase}`);
    screen.render();
  };
  
  const closeProgress = () => {
    if (progressInterval) clearInterval(progressInterval);
    if (!backgrounded) {
      progressBox.destroy();
    }
    fileList.focus();
    screen.render();
  };
  
  const moveToBackground = () => {
    backgrounded = true;
    progressBox.destroy();
    fileList.focus();
    screen.render();
    showMessage(`Upload running in background (Tag: ${tagUid})`, 'info');
  };
  
  bgButton.on('press', moveToBackground);
  progressBox.key(['escape', 'b'], moveToBackground);
  
  try {
    // Create tag
    tagUid = await createTag();
    
    // Save initial metadata
    saveUploadMeta(tagUid, {
      name: fileName,
      date: new Date().toISOString(),
      batchId: batchId,
      reference: null,
    });
    
    tagInfo.setContent(`Tag UID: {green-fg}${tagUid}{/green-fg}`);
    statusLine.setContent('{yellow-fg}Uploading to local Bee node...{/yellow-fg}');
    progressBox.style.border.fg = 'yellow';
    screen.render();
    
    const fileData = fs.readFileSync(filePath);
    const encodedName = encodeURIComponent(fileName);
    
    // Start progress tracking
    progressInterval = setInterval(async () => {
      try {
        const tag = await getTagStatus(tagUid);
        if (tag.split > 0) {
          const total = tag.split;
          const seen = tag.seen || 0;
          const sent = tag.sent || 0;
          const synced = tag.synced || 0;
          
          // Use the most advanced progress indicator
          const progress = Math.max(seen, sent, synced);
          const percent = (progress / total) * 100;
          const transferred = Math.round((progress / total) * fileSize);
          
          if (synced >= total) {
            updateProgress('Synced with network ✓', 100, fileSize);
            statusLine.setContent('{green-fg}Upload complete!{/green-fg}');
            progressBox.style.border.fg = 'green';
          } else if (sent > 0) {
            updateProgress(`Syncing (${synced}/${total} chunks)`, percent, transferred);
            statusLine.setContent('{cyan-fg}Syncing with Swarm network...{/cyan-fg}');
            progressBox.style.border.fg = 'cyan';
          } else if (seen > 0) {
            updateProgress(`Uploading (${seen}/${total} chunks)`, percent, transferred);
            statusLine.setContent('{yellow-fg}Uploading to Bee node...{/yellow-fg}');
          } else {
            updateProgress(`Processing (${tag.split} chunks)`, 5, 0);
          }
        }
      } catch {
        // Ignore polling errors
      }
    }, 300);
    
    const result = await httpRequest({
      hostname: '127.0.0.1',
      port: 1633,
      path: `/bzz?name=${encodedName}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileData.length,
        'swarm-postage-batch-id': batchId,
        'swarm-tag': tagUid.toString(),
      },
    }, fileData);
    
    // Save reference to metadata
    saveUploadMeta(tagUid, { reference: result.reference });

    if (backgrounded) {
      if (progressInterval) clearInterval(progressInterval);
      return;
    }
    
    statusLine.setContent('{cyan-fg}Syncing with Swarm network...{/cyan-fg}');
    progressBox.style.border.fg = 'cyan';
    screen.render();
    
    // Wait for sync to complete (poll for up to 2 minutes)
    let syncComplete = false;
    for (let i = 0; i < 240 && !syncComplete && !backgrounded; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const tag = await getTagStatus(tagUid);
        if (tag.synced >= tag.split && tag.split > 0) {
          syncComplete = true;
        }
      } catch {}
    }
    
    if (backgrounded) {
      if (progressInterval) clearInterval(progressInterval);
      return;
    }
    
    closeProgress();
    
    if (syncComplete) {
      showMessage(`Synced: ${fileName} → ${result.reference.slice(0, 40)}...`, 'success');
    } else {
      showMessage(`Uploaded (syncing): ${fileName} → ${result.reference.slice(0, 32)}...`, 'success');
    }
    
  } catch (err) {
    if (backgrounded) {
      if (progressInterval) clearInterval(progressInterval);
      showMessage(`Upload failed: ${err.message}`, 'error');
      return;
    }
    closeProgress();
    showMessage(`Upload failed: ${err.message}`, 'error');
  }
}

function showMessage(text, type = 'info') {
  const colors = { info: 'cyan', success: 'green', error: 'red' };
  footer.setContent(` {${colors[type]}-fg}${text}{/${colors[type]}-fg}`);
  screen.render();
  
  setTimeout(() => {
    updateFooter();
    screen.render();
  }, 3000);
}

function promptInput(label, currentValue, callback) {
  const prompt = blessed.prompt({
    parent: screen,
    top: 'center',
    left: 'center',
    width: 70,
    height: 8,
    border: 'line',
    label: ` ${label} `,
    tags: true,
    keys: true,
    vi: false,
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: 'cyan' },
    },
  });

  prompt.input(`Enter ${label}:`, currentValue, (err, value) => {
    prompt.destroy();
    screen.render();
    if (value !== null && value !== undefined && value.trim() !== '') {
      callback(value.trim());
    }
    fileList.focus();
  });
}

// Key bindings
screen.key(['q', 'f10', 'C-c'], () => process.exit(0));

screen.key(['tab'], () => {
  if (activePanel === 'left') {
    activePanel = 'right';
    leftBox.style.border.fg = 'gray';
    rightBox.style.border.fg = 'green';
    tagList.focus();
  } else {
    activePanel = 'left';
    leftBox.style.border.fg = 'cyan';
    rightBox.style.border.fg = 'gray';
    fileList.focus();
  }
  screen.render();
});

screen.key(['f5'], () => {
  const selected = fileList.entries?.[fileList.selected];
  if (selected && !selected.isDir && selected.path) {
    showUploadConfirmation(selected.path, selected.size, () => {
      uploadFile(selected.path);
    });
  } else if (selected?.isDir) {
    showMessage('Cannot upload a directory', 'error');
  }
});

screen.key(['f2'], () => {
  promptInput('Batch ID', batchId, (value) => {
    batchId = value;
    saveConfig({ ...loadConfig(), batchId });
    updateBatchBar();
    showMessage(`Batch ID saved: ${batchId.slice(0, 24)}...`, 'success');
  });
});


fileList.on('select item', () => {
  updateFooter();
  screen.render();
});

fileList.key(['enter'], () => {
  const selected = fileList.entries?.[fileList.selected];
  if (selected?.isDir) {
    const newDir = selected.name === '..' 
      ? path.dirname(currentDir) 
      : path.join(currentDir, selected.name);
    loadDirectory(newDir);
  }
});

fileList.key(['backspace'], () => {
  if (currentDir !== '/') {
    loadDirectory(path.dirname(currentDir));
  }
});

tagList.key(['enter'], () => {
  const selected = tagList.tags?.[tagList.selected];
  if (selected) {
    showUploadDetail(selected);
  }
});

tagList.key(['escape'], () => {
  closeUploadDetail();
});

screen.key(['escape'], () => {
  if (selectedUploadDetail) {
    closeUploadDetail();
  }
});

// Initialize
updateBatchBar();
loadDirectory(currentDir);
leftBox.style.border.fg = 'cyan';
rightBox.style.border.fg = 'gray';
fileList.focus();
screen.render();

// Initial tag fetch and periodic refresh
refreshTagList();
setInterval(refreshTagList, 1000);

