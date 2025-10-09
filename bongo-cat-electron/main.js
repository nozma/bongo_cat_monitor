const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// Import our custom modules
const SettingsManager = require('./src/settings');
const ESP32SerialManager = require('./src/serial');
const SystemMonitor = require('./src/system-monitor');
const KeyboardMonitor = require('./src/keyboard-monitor');

const isDev = process.argv.includes('--dev');

// Keep a global reference of the window object
let mainWindow;
let tray;
let isQuitting = false;

// Initialize global instances
let eventEmitter;
let settingsManager;
let esp32SerialManager;
let systemMonitor;
let keyboardMonitor;

// Monitoring state
let monitoringActive = false;
let timeUpdateTimer = null;
let statsInterval = null;
let macKeyServerReady = false;

// Development mode indicator
if (isDev) {
  console.log('Running in development mode');
}

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 350,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: false, // Security: disable node integration
      contextIsolation: true, // Security: enable context isolation
      preload: path.join(__dirname, 'preload.js'), // Use preload script
      enableRemoteModule: false // Security: disable remote module
    },
    icon: path.join(__dirname, 'assets', 'icons', 'icon.png'),
    show: false, // Don't show until ready
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default'
  });

  // Load the app
  mainWindow.loadFile('renderer/index.html');

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // Open DevTools in development
    if (isDev) {
      mainWindow.webContents.openDevTools();
    }
  });

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle window close (minimize to tray instead of quit)
  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Handle window minimize (hide on Mac)
  mainWindow.on('minimize', (event) => {
    if (process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (process.platform === 'darwin' && app.dock) {
    // Hide the Dock icon while keeping the menu bar available
    app.dock.hide();
    mainWindow.on('show', () => {
      app.dock.hide();
    });
  }
}

function createTray() {
  // Create tray icon
  const iconPath = path.join(__dirname, 'assets', 'icons', 'tray.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

  // Create context menu
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Bongo Cat',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('show-settings');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Bongo Cat',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('Bongo Cat - ESP32 Desktop Companion');

  // Handle tray click
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

// Initialize application modules
function initializeModules() {
  try {
    ensureMacKeyServerExecutable();

    // Create event emitter for inter-module communication
    eventEmitter = new EventEmitter();
    
    // Initialize managers
    settingsManager = new SettingsManager();
    esp32SerialManager = new ESP32SerialManager(eventEmitter);
    systemMonitor = new SystemMonitor(eventEmitter);
    keyboardMonitor = new KeyboardMonitor(eventEmitter);
    
    // Set up event forwarding to renderer
    setupEventForwarding();
    
    console.log('All modules initialized successfully');
  } catch (error) {
    console.error('Failed to initialize modules:', error);
  }
}

// Setup event forwarding from modules to renderer
function setupEventForwarding() {
  eventEmitter.on('connection-change', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('connection-change', data);
    }
  });
  
  // Combined stats handler for ESP32 protocol
  let lastSystemStats = { cpu: 0, memory: 0 };
  let lastTypingStats = { wpm: 0, isActive: false };
  
  eventEmitter.on('system-stats', (stats) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system-stats', stats);
    }
    
    // Cache system stats for combined sending
    lastSystemStats = stats;
  });
  
  eventEmitter.on('typing-stats', (stats) => {
    // Only log when there's actual WPM activity to reduce spam

    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('typing-stats', stats);
    }
    
    // Cache typing stats for combined sending
    lastTypingStats = stats;
  });
  
  // Handle keyboard fallback notifications
  eventEmitter.on('keyboard-fallback', (data) => {
    console.log('⚠️ Keyboard monitoring fallback mode enabled');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('keyboard-fallback', data);
    }
  });
  
  // FAST STATS SENDING - Responsive like Python app
  if (!statsInterval) {
    statsInterval = setInterval(() => {
      if (esp32SerialManager && esp32SerialManager.getConnectionStatus().isConnected) {
        // Send stats more frequently during active typing (like Python app)
        const isTypingActive = lastTypingStats && lastTypingStats.isActive;
        esp32SerialManager.sendCombinedStats(lastSystemStats, lastTypingStats);
      }
    }, 1000); // 1 second for responsive animations (was 2000ms)
  }
  
  // Auto-start monitoring when app is ready
  setTimeout(async () => {
    try {
      console.log('🚀 Auto-starting system monitoring...');
      if (systemMonitor) {
        await systemMonitor.startMonitoring(2000); // 2-second intervals
        console.log('✅ System monitoring started automatically');
      }
      
      console.log('🚀 Auto-starting keyboard monitoring...');
      if (keyboardMonitor) {
        await keyboardMonitor.startMonitoring();
        console.log('✅ Keyboard monitoring started automatically');
        console.log('🧪 Type something now to test if keyboard monitoring works...');
        console.log('💡 If no keys are detected, check permissions or run as administrator');
      }
      
      // Auto-start as monitoring state
      monitoringActive = true;
      
    } catch (error) {
      console.error('Failed to auto-start monitoring:', error);
    }
  }, 1000); // Start after 1 second delay

  eventEmitter.on('serial-data', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('serial-data', data);
    }
  });

  ensureTimeUpdateTimer();
}

function ensureTimeUpdateTimer() {
  if (timeUpdateTimer) {
    return;
  }
  timeUpdateTimer = setInterval(async () => {
    try {
      if (esp32SerialManager && esp32SerialManager.getConnectionStatus().isConnected) {
        await esp32SerialManager.sendTimeUpdate();
      }
    } catch (error) {
      console.error('Time update failed:', error);
    }
  }, 60000);
}

function ensureMacKeyServerExecutable() {
  if (process.platform !== 'darwin' || macKeyServerReady) {
    return;
  }

  const candidatePaths = [
    path.join(__dirname, 'node_modules', 'node-global-key-listener', 'bin', 'MacKeyServer'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'node-global-key-listener', 'bin', 'MacKeyServer')
  ];

  for (const candidate of candidatePaths) {
    try {
      if (!candidate || !fs.existsSync(candidate)) {
        continue;
      }

      const stats = fs.statSync(candidate);
      const hasExecute = (stats.mode & 0o111) !== 0;

      if (!hasExecute) {
        fs.chmodSync(candidate, stats.mode | 0o755);
        console.log(`Updated execute permissions for MacKeyServer binary: ${candidate}`);
      }

      macKeyServerReady = true;
      return;
    } catch (error) {
      console.error(`Failed to ensure MacKeyServer executable at ${candidate}:`, error);
    }
  }

  console.warn('MacKeyServer binary not found; WPM tracking may be unavailable.');
}

// App event handlers
app.whenReady().then(() => {
  // Initialize modules first
  initializeModules();
  
  // Create UI
  createWindow();
  createTray();

  // Handle app activation (macOS)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  // On macOS, keep app running even when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle app quit
app.on('before-quit', () => {
  isQuitting = true;
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  contents.on('new-window', (event, navigationUrl) => {
    event.preventDefault();
  });
});

// =============================================================================
// IPC HANDLERS - Bridge between renderer and backend modules
// =============================================================================

// App Info Handlers
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

// Serial Communication Handlers
ipcMain.handle('get-serial-ports', async () => {
  try {
    if (!esp32SerialManager) {
      throw new Error('Serial manager not initialized');
    }
    return await esp32SerialManager.getAvailablePorts();
  } catch (error) {
    console.error('Get serial ports error:', error);
    throw error;
  }
});

ipcMain.handle('connect-to-device', async (event, port) => {
  try {
    if (!esp32SerialManager) {
      throw new Error('Serial manager not initialized');
    }
    
    const esp32Settings = settingsManager.getESP32Settings();
    const result = await esp32SerialManager.connectToDevice(port, esp32Settings);
    
    // Save successful port for auto-connect
    if (result.success) {
      settingsManager.saveLastUsedPort(port);
    }
    
    return result;
  } catch (error) {
    console.error('Connect to device error:', error);
    throw error;
  }
});

ipcMain.handle('disconnect-device', async () => {
  try {
    if (!esp32SerialManager) {
      throw new Error('Serial manager not initialized');
    }
    return await esp32SerialManager.disconnect();
  } catch (error) {
    console.error('Disconnect device error:', error);
    throw error;
  }
});

ipcMain.handle('send-serial-data', async (event, data) => {
  try {
    if (!esp32SerialManager) {
      throw new Error('Serial manager not initialized');
    }
    await esp32SerialManager.sendCommand(data);
    return { success: true };
  } catch (error) {
    console.error('Send serial data error:', error);
    throw error;
  }
});

// System Monitoring Handlers
ipcMain.handle('get-system-stats', async () => {
  try {
    if (!systemMonitor) {
      throw new Error('System monitor not initialized');
    }
    return await systemMonitor.getCurrentStats();
  } catch (error) {
    console.error('Get system stats error:', error);
    throw error;
  }
});

ipcMain.handle('start-monitoring', async () => {
  try {
    if (!systemMonitor) {
      throw new Error('System monitor not initialized');
    }
    
    const updateInterval = settingsManager.getUpdateInterval();
    const result = await systemMonitor.startMonitoring(updateInterval);
    
    if (result.success) {
      monitoringActive = true;
      ensureTimeUpdateTimer();
    }
    
    return result;
  } catch (error) {
    console.error('Start monitoring error:', error);
    throw error;
  }
});

ipcMain.handle('stop-monitoring', async () => {
  try {
    if (!systemMonitor) {
      throw new Error('System monitor not initialized');
    }
    
    const result = systemMonitor.stopMonitoring();
    monitoringActive = false;
    
    return result;
  } catch (error) {
    console.error('Stop monitoring error:', error);
    throw error;
  }
});

// Keyboard Monitoring Handlers
ipcMain.handle('start-keyboard-monitoring', async () => {
  try {
    if (!keyboardMonitor) {
      throw new Error('Keyboard monitor not initialized');
    }
    return await keyboardMonitor.startMonitoring();
  } catch (error) {
    console.error('Start keyboard monitoring error:', error);
    throw error;
  }
});

ipcMain.handle('stop-keyboard-monitoring', async () => {
  try {
    if (!keyboardMonitor) {
      throw new Error('Keyboard monitor not initialized');
    }
    return await keyboardMonitor.stopMonitoring();
  } catch (error) {
    console.error('Stop keyboard monitoring error:', error);
    throw error;
  }
});

ipcMain.handle('get-typing-stats', async () => {
  try {
    if (!keyboardMonitor) {
      throw new Error('Keyboard monitor not initialized');
    }
    return keyboardMonitor.getCurrentStats();
  } catch (error) {
    console.error('Get typing stats error:', error);
    throw error;
  }
});

ipcMain.handle('reset-typing-stats', async () => {
  try {
    if (!keyboardMonitor) {
      throw new Error('Keyboard monitor not initialized');
    }
    keyboardMonitor.resetSession();
    const stats = keyboardMonitor.getCurrentStats();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('typing-stats', stats);
    }

    return { success: true, stats };
  } catch (error) {
    console.error('Reset typing stats error:', error);
    throw error;
  }
});

// Settings Management Handlers
ipcMain.handle('get-settings', async () => {
  try {
    if (!settingsManager) {
      throw new Error('Settings manager not initialized');
    }
    return settingsManager.getAllSettings();
  } catch (error) {
    console.error('Get settings error:', error);
    throw error;
  }
});

ipcMain.handle('apply-settings', async (event, settings) => {
  try {
    console.log('Applying settings temporarily (not saving to disk):', settings);
    
    // Validate settings object
    if (!settings || typeof settings !== 'object') {
      throw new Error('Invalid settings object provided');
    }
    
    // Check if core modules are initialized
    console.log('Module status:', {
      systemMonitor: !!systemMonitor,
      esp32SerialManager: !!esp32SerialManager,
      settingsManager: !!settingsManager
    });
    
    // Apply settings that affect monitoring without saving to disk
    if (settings.updateInterval && systemMonitor && systemMonitor.isActive()) {
      try {
        systemMonitor.updateInterval(settings.updateInterval);
      } catch (error) {
        console.error('Failed to update monitoring interval:', error);
        // Don't throw - this shouldn't prevent other settings from applying
      }
    }
    
    // Send settings to ESP32 device if connected
    if (esp32SerialManager && esp32SerialManager.isConnected) {
      try {
        await esp32SerialManager.sendDisplaySettings(settings);
        console.log('Settings sent to ESP32 device successfully');
      } catch (error) {
        console.error('Failed to send settings to ESP32:', error);
        // Don't throw here, as the settings were applied locally successfully
      }
    }
    
    console.log('Settings applied successfully');
    return { success: true };
  } catch (error) {
    console.error('Apply settings error:', error);
    console.error('Error stack:', error.stack);
    throw new Error(`Failed to apply settings: ${error.message}`);
  }
});

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    if (!settingsManager) {
      throw new Error('Settings manager not initialized');
    }
    
    const success = settingsManager.updateSettings(settings);
    
    // Apply settings that affect monitoring
    if (settings.updateInterval && systemMonitor && systemMonitor.isActive()) {
      try {
        systemMonitor.updateInterval(settings.updateInterval);
      } catch (error) {
        console.error('Failed to update monitoring interval:', error);
        // Don't throw - this shouldn't prevent other settings from applying
      }
    }
    
    // Send settings to ESP32 device if connected
    if (esp32SerialManager && esp32SerialManager.isConnected) {
      try {
        await esp32SerialManager.sendDisplaySettings(settings);
        console.log('Settings saved and sent to ESP32 device successfully');
      } catch (error) {
        console.error('Failed to send settings to ESP32:', error);
        // Don't throw here, as the settings were saved locally successfully
      }
    }
    
    return { success };
  } catch (error) {
    console.error('Save settings error:', error);
    throw error;
  }
});

ipcMain.handle('reset-settings', async () => {
  try {
    if (!settingsManager) {
      throw new Error('Settings manager not initialized');
    }
    
    const success = settingsManager.resetToDefaults();
    return { success };
  } catch (error) {
    console.error('Reset settings error:', error);
    throw error;
  }
});



// Cleanup on app quit
app.on('before-quit', async () => {
  isQuitting = true;
  
  try {
    // Stop all monitoring
    if (systemMonitor && systemMonitor.isActive()) {
      systemMonitor.stopMonitoring();
    }
    
    if (keyboardMonitor && keyboardMonitor.isActive()) {
      await keyboardMonitor.stopMonitoring();
    }
    
    // Disconnect ESP32
    if (esp32SerialManager && esp32SerialManager.getConnectionStatus().isConnected) {
      esp32SerialManager.forceShutdown?.();
      await esp32SerialManager.disconnect();
    }
    
    console.log('App cleanup completed');
  } catch (error) {
    console.error('Error during app cleanup:', error);
  }
});

app.on('will-quit', () => {
  try {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
    if (timeUpdateTimer) {
      clearInterval(timeUpdateTimer);
      timeUpdateTimer = null;
    }
    if (keyboardMonitor) {
      keyboardMonitor.forceShutdown?.();
    }
    if (esp32SerialManager) {
      esp32SerialManager.forceShutdown?.();
    }
  } catch (error) {
    console.error('Error during will-quit cleanup:', error);
  }
});
