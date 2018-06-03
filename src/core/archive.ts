import * as fs from 'fs';
import Log from '../utils/log';
import { download, decrypt, mergeVideo } from '../utils/media';
import axios from 'axios';
import { exec, deleteDirectory } from '../utils/system';
import M3U8 from './m3u8';
import Downloader, { DownloaderConfig } from './downloader';
const path = require('path');



export interface Chunk {
    url: string;
    filename: string;
}

class ArchiveDownloader extends Downloader {
    tempPath: string;
    outputPath: string = './output.mkv';
    m3u8Path: string;
    m3u8: M3U8;

    chunks: Chunk[];
    outputFileList: string[];

    totalChunks: number;
    runningThreads: number = 0;
   
    iv: string;
    prefix: string;

    /**
     * 
     * @param m3u8Path 
     * @param config
     * @param config.threads 线程数量 
     */
    constructor(m3u8Path: string, { threads, output, key }: DownloaderConfig = {
        threads: 5
    }) {
        super(m3u8Path, {
            threads,
            output,
            key
        });
    }

    async download() {
        this.startedAt = new Date().valueOf();
        // parse m3u8
        if (this.m3u8.isEncrypted) {
            // Encrypted
            const key = this.m3u8.getKey();
            const iv = this.m3u8.getIV();
            if (!key || !iv) {
                Log.error('Unsupported site.');
            }
            if (key.startsWith('abemafresh')) {
                Log.info('Site comfirmed: FreshTV.');
                const parser = await import('./parsers/freshtv');
                const parseResult = parser.default.parse({
                    key,
                    iv
                });
                [this.key, this.iv, this.prefix] = [parseResult.key, parseResult.iv, parseResult.prefix];
                Log.info(`Key: ${this.key}; IV: ${this.iv}.`);
            } else if (key.startsWith('abematv-license')) {
                Log.info('Site comfirmed: AbemaTV.');
                const parser = await import('./parsers/abema');
                const parseResult = parser.default.parse({
                    key,
                    iv,
                    options: {
                        key: this.key
                    }
                });
                [this.key, this.iv, this.prefix] = [parseResult.key, parseResult.iv, parseResult.prefix];
                Log.info(`Key: ${this.key}; IV: ${this.iv}.`);
            } else {

            }
        } else {
            // Not encrypted
            if (this.m3u8Path.includes('freshlive')) {
                // FreshTV
                const parser = await import('./parsers/freshtv');
                this.prefix = parser.default.prefix;
            }
        }

        Log.info(`Start downloading with ${this.threads} thread(s).`);
        this.chunks = this.m3u8.chunks.map(chunk => {
            return {
                url: this.prefix + chunk,
                filename: chunk.match(/\/([^\/]+?\.ts)/)[1]
            };
        });
        this.totalChunks = this.chunks.length;
        this.outputFileList = this.chunks.map(chunk => {
            if (this.m3u8.isEncrypted) {
                return path.resolve(this.tempPath, `./${chunk.filename}.decrypt`);
            } else {
                return path.resolve(this.tempPath, `./${chunk.filename}`);
            }
        })
        this.checkQueue();
    }

    handleTask(task: Chunk) {
        return new Promise(async (resolve, reject) => {
            Log.debug(`Downloading ${task.filename}`);
            try {
                await download(task.url, path.resolve(this.tempPath, `./${task.filename}`));
                Log.debug(`Downloading ${task.filename} succeed.`);
                if (this.m3u8.isEncrypted) {
                    await decrypt(path.resolve(this.tempPath, `./${task.filename}`), path.resolve(this.tempPath, `./${task.filename}`) + '.decrypt', this.key, this.iv);
                    Log.debug(`Decrypting ${task.filename} succeed`);
                }
                resolve();
            } catch (e) {
                Log.info(`Downloading or decrypting ${task.filename} failed. Retry later.`);
                reject(e);
            }            
        });
    }

    /**
     * calculate ETA
     */
    getETA() {
        const usedTime = new Date().valueOf() - this.startedAt;
        const remainingTimeInSeconds = Math.round(((usedTime / this.finishedChunks * this.totalChunks) - usedTime) / 1000)
        if (remainingTimeInSeconds < 60) {
            return `${remainingTimeInSeconds}s`;
        } else if (remainingTimeInSeconds < 3600) {
            return `${Math.floor(remainingTimeInSeconds / 60)}m ${remainingTimeInSeconds % 60}s`;
        } else {
            return `${Math.floor(remainingTimeInSeconds / 3600)}h ${Math.floor((remainingTimeInSeconds % 3600) / 60)}m ${remainingTimeInSeconds % 60}s`;
        }
    }

    /**
     * Check task queue
     */
    checkQueue() {
        if (this.chunks.length > 0 && this.runningThreads < this.threads) {
            const task = this.chunks.shift();
            this.runningThreads++;
            this.handleTask(task).then(() => {
                this.finishedChunks++;
                this.runningThreads--;
                Log.info(`Proccessing ${task.filename} finished. (${this.finishedChunks} / ${this.totalChunks} or ${(this.finishedChunks / this.totalChunks * 100).toFixed(2)}% | Avg Speed: ${
                    this.calculateSpeedByChunk()
                } chunks/s or ${
                    this.calculateSpeedByRatio()
                }x | ETA: ${
                    this.getETA()
                })`);
                this.checkQueue();
            }).catch(e => {
                console.error(e);
                this.runningThreads--;
                this.chunks.push(task);
                this.checkQueue();
            });
            this.checkQueue();
        }
        if (this.chunks.length === 0 && this.runningThreads === 0) {
            Log.info('All chunks downloaded. Start merging chunks.');
            mergeVideo(this.outputFileList, this.outputPath).then(async () => {
                Log.info('End of merging.');
                Log.info('Starting cleaning temporary files.');
                await deleteDirectory(this.tempPath);
                Log.info(`All finished. Check your file at [${this.outputPath}] .`);
            });
        }
    }
}

export default ArchiveDownloader;