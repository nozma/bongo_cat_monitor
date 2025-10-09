const si = require('systeminformation');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * System Monitor
 * Tracks CPU, RAM, and other system statistics
 */
class SystemMonitor {
    constructor(eventEmitter) {
        this.eventEmitter = eventEmitter;
        this.isMonitoring = false;
        this.monitoringInterval = null;
        this.updateInterval = 1000; // Default 1 second
        
        // Cache for system stats
        this.lastStats = {
            cpu: 0,
            memory: 0,
            memoryDetails: {
                usedBytes: 0,
                totalBytes: 0
            },
            timestamp: Date.now()
        };
        
        // Performance optimization
        this.cpuLoadArray = [];
        this.maxCpuSamples = 5; // Keep last 5 samples for smoothing
        
        console.log('System Monitor initialized');
    }

    /**
     * Start system monitoring
     */
    async startMonitoring(interval = 1000) {
        try {
            if (this.isMonitoring) {
                console.log('System monitoring already running');
                return { success: true };
            }

            this.updateInterval = interval;
            console.log(`Starting system monitoring with ${interval}ms interval`);

            // Get initial system info
            await this.updateSystemStats();

            // Start monitoring loop
            this.monitoringInterval = setInterval(async () => {
                try {
                    await this.updateSystemStats();
                } catch (error) {
                    console.error('Error in monitoring loop:', error);
                }
            }, this.updateInterval);

            this.isMonitoring = true;
            console.log('System monitoring started successfully');
            
            return { success: true };

        } catch (error) {
            console.error('Failed to start system monitoring:', error);
            throw new Error(`Monitoring start failed: ${error.message}`);
        }
    }

    /**
     * Stop system monitoring
     */
    stopMonitoring() {
        try {
            if (!this.isMonitoring) {
                console.log('System monitoring not running');
                return { success: true };
            }

            if (this.monitoringInterval) {
                clearInterval(this.monitoringInterval);
                this.monitoringInterval = null;
            }

            this.isMonitoring = false;
            this.cpuLoadArray = [];
            
            console.log('System monitoring stopped');
            return { success: true };

        } catch (error) {
            console.error('Failed to stop system monitoring:', error);
            throw new Error(`Monitoring stop failed: ${error.message}`);
        }
    }

    /**
     * macOS-specific memory breakdown using vm_stat to align with Activity Monitor
     */
    async _getMacMemoryBreakdown() {
        try {
            const { stdout } = await execFileAsync('vm_stat');
            const lines = stdout
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length);

            const pageSizeMatch = lines[0]?.match(/page size of (\d+) bytes/);
            const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

            const findLine = (label) => lines.find(l => l.startsWith(label));

            const parsePages = (label) => {
                const line = findLine(label);
                if (!line) return 0;
                const match = line.match(/:\s*([\d\.]+)/);
                if (!match) return 0;
                // Values end with a period; remove and parse
                return parseInt(match[1].replace('.', ''), 10) || 0;
            };

            const activePages = parsePages('Pages active');
            const speculativePages = parsePages('Pages speculative');
            const wiredPages = parsePages('Pages wired down');
            const compressedPages = parsePages('Pages occupied by compressor');
            const inactivePages = parsePages('Pages inactive');
            const fileBackedPages = parsePages('File-backed pages');
            const purgeablePages = parsePages('Pages purgeable');
            const anonymousPages = parsePages('Anonymous pages');

            const activeBytes = (activePages + speculativePages) * pageSize;
            const inactiveBytes = inactivePages * pageSize;
            const compressedBytes = compressedPages * pageSize;
            const wiredBytes = wiredPages * pageSize;
            const fileBackedBytes = fileBackedPages * pageSize;
            const purgeableBytes = purgeablePages * pageSize;
            const anonymousBytes = anonymousPages * pageSize;

            // Approximate Activity Monitor metrics:
            // App Memory ≈ Anonymous memory (private) + compressed
            let appBytes = anonymousBytes + compressedBytes;

            // Fallback if anonymous not available
            if (!appBytes && (activeBytes || inactiveBytes)) {
                appBytes = Math.max(
                    0,
                    (activeBytes + inactiveBytes) - fileBackedBytes
                ) + compressedBytes;
            }

            const usedBytes = appBytes + wiredBytes;

            return {
                source: 'vm_stat',
                pageSize,
                activeBytes,
                wiredBytes,
                compressedBytes,
                inactiveBytes,
                fileBackedBytes,
                purgeableBytes,
                anonymousBytes,
                appBytes,
                usedBytes
            };
        } catch (error) {
            console.warn('Failed to read macOS memory breakdown via vm_stat:', error.message);
            return null;
        }
    }

    /**
     * Update system statistics
     */
    async updateSystemStats() {
        try {
            // Get CPU usage (with interval for accuracy)
            const cpuLoad = await si.currentLoad();
            const cpuUsage = cpuLoad.currentLoad || 0;

            // Get memory usage with platform-specific adjustments
            const memoryInfo = await si.mem();
            const totalBytes = memoryInfo.total || 0;

            let breakdownDetails = {};
            let usedBytes = memoryInfo.used || 0;
            if (totalBytes > 0) {
                if (process.platform === 'darwin') {
                    const macBreakdown = await this._getMacMemoryBreakdown().catch(() => null);
                    if (macBreakdown && macBreakdown.usedBytes > 0) {
                        usedBytes = macBreakdown.usedBytes;
                        breakdownDetails = macBreakdown;
                    } else {
                        const active = memoryInfo.active || 0;
                        const wired = memoryInfo.wired || 0;
                        const compressed = memoryInfo.compressed || 0;
                        const computedUsed = active + wired + compressed;
                        if (computedUsed > 0) {
                            usedBytes = computedUsed;
                            breakdownDetails = {
                                source: 'systeminformation',
                                activeBytes: active,
                                wiredBytes: wired,
                                compressedBytes: compressed,
                                appBytes: active + compressed,
                                usedBytes: computedUsed
                            };
                        }
                    }
                } else {
                    // Exclude cache/buffers for other platforms when available
                    const buffers = memoryInfo.buffers || 0;
                    const cached = (memoryInfo.cached || 0) + (memoryInfo.buffcache || 0);
                    const computedUsed = memoryInfo.used - buffers - cached;
                    if (computedUsed > 0) {
                        usedBytes = computedUsed;
                    }
                }
            }

            if (totalBytes > 0) {
                usedBytes = Math.min(Math.max(usedBytes, 0), totalBytes);
            }

            const memoryUsage = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

            // Smooth CPU readings to reduce fluctuation
            this.cpuLoadArray.push(cpuUsage);
            if (this.cpuLoadArray.length > this.maxCpuSamples) {
                this.cpuLoadArray.shift();
            }
            
            const smoothedCpu = this.cpuLoadArray.reduce((a, b) => a + b, 0) / this.cpuLoadArray.length;

            // Update cache
            this.lastStats = {
                cpu: Math.round(smoothedCpu * 10) / 10, // Round to 1 decimal
                memory: Math.round(memoryUsage * 10) / 10, // Round to 1 decimal
                memoryDetails: {
                    usedBytes,
                    totalBytes,
                    ...breakdownDetails
                },
                timestamp: Date.now()
            };

            // Emit stats update
            this.eventEmitter.emit('system-stats', this.lastStats);

            return this.lastStats;

        } catch (error) {
            console.error('Failed to update system stats:', error);
            
            // Return cached stats on error
            return this.lastStats;
        }
    }

    /**
     * Get current system statistics
     */
    async getCurrentStats() {
        try {
            // If monitoring is active, return cached stats
            if (this.isMonitoring) {
                return this.lastStats;
            }

            // Otherwise, get fresh stats
            return await this.updateSystemStats();

        } catch (error) {
            console.error('Failed to get current stats:', error);
            throw new Error(`Stats retrieval failed: ${error.message}`);
        }
    }

    /**
     * Get detailed system information
     */
    async getDetailedSystemInfo() {
        try {
            const [
                cpu,
                memory,
                osInfo,
                system,
                diskLayout,
                networkInterfaces
            ] = await Promise.all([
                si.cpu(),
                si.mem(),
                si.osInfo(),
                si.system(),
                si.diskLayout(),
                si.networkInterfaces()
            ]);

            return {
                cpu: {
                    manufacturer: cpu.manufacturer,
                    brand: cpu.brand,
                    speed: cpu.speed,
                    cores: cpu.cores,
                    physicalCores: cpu.physicalCores,
                    processors: cpu.processors
                },
                memory: {
                    total: memory.total,
                    free: memory.free,
                    used: memory.used,
                    active: memory.active,
                    available: memory.available
                },
                os: {
                    platform: osInfo.platform,
                    distro: osInfo.distro,
                    release: osInfo.release,
                    arch: osInfo.arch,
                    hostname: osInfo.hostname
                },
                system: {
                    manufacturer: system.manufacturer,
                    model: system.model,
                    version: system.version,
                    sku: system.sku
                },
                storage: diskLayout.map(disk => ({
                    name: disk.name,
                    type: disk.type,
                    size: disk.size,
                    interfaceType: disk.interfaceType
                })),
                network: networkInterfaces.filter(iface => !iface.internal).map(iface => ({
                    iface: iface.iface,
                    type: iface.type,
                    speed: iface.speed,
                    mac: iface.mac
                }))
            };

        } catch (error) {
            console.error('Failed to get detailed system info:', error);
            throw new Error(`System info retrieval failed: ${error.message}`);
        }
    }

    /**
     * Get system performance summary
     */
    async getPerformanceSummary() {
        try {
            const [
                currentLoad,
                memory,
                processes,
                disksIO,
                networkStats
            ] = await Promise.all([
                si.currentLoad(),
                si.mem(),
                si.processes(),
                si.disksIO(),
                si.networkStats()
            ]);

            return {
                cpu: {
                    usage: currentLoad.currentLoad,
                    loadAvg: currentLoad.avgLoad,
                    cores: currentLoad.cpus.map(cpu => ({
                        load: cpu.load,
                        loadUser: cpu.loadUser,
                        loadSystem: cpu.loadSystem
                    }))
                },
                memory: {
                    usagePercent: (memory.used / memory.total) * 100,
                    totalGB: Math.round(memory.total / (1024 * 1024 * 1024) * 10) / 10,
                    usedGB: Math.round(memory.used / (1024 * 1024 * 1024) * 10) / 10,
                    freeGB: Math.round(memory.free / (1024 * 1024 * 1024) * 10) / 10
                },
                processes: {
                    running: processes.running,
                    blocked: processes.blocked,
                    sleeping: processes.sleeping,
                    top: processes.list.slice(0, 5).map(proc => ({
                        name: proc.name,
                        cpu: proc.cpu,
                        memory: proc.memory
                    }))
                },
                disk: {
                    readIOPS: disksIO.rIO,
                    writeIOPS: disksIO.wIO,
                    readSpeed: disksIO.rIO_sec,
                    writeSpeed: disksIO.wIO_sec
                },
                network: networkStats.map(stat => ({
                    iface: stat.iface,
                    rx: stat.rx_bytes,
                    tx: stat.tx_bytes,
                    rxSpeed: stat.rx_sec,
                    txSpeed: stat.tx_sec
                }))
            };

        } catch (error) {
            console.error('Failed to get performance summary:', error);
            throw new Error(`Performance summary failed: ${error.message}`);
        }
    }

    /**
     * Check if monitoring is active
     */
    isActive() {
        return this.isMonitoring;
    }

    /**
     * Update monitoring interval
     */
    updateInterval(newInterval) {
        if (newInterval < 100 || newInterval > 10000) {
            throw new Error('Interval must be between 100ms and 10000ms');
        }

        this.updateInterval = newInterval;
        
        if (this.isMonitoring) {
            // Restart monitoring with new interval
            this.stopMonitoring();
            this.startMonitoring(newInterval);
        }

        console.log(`Monitoring interval updated to ${newInterval}ms`);
    }

    /**
     * Get monitoring status
     */
    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            interval: this.updateInterval,
            lastUpdate: this.lastStats.timestamp,
            lastStats: this.lastStats
        };
    }
}

module.exports = SystemMonitor;
