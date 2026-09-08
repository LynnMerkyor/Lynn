import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const homeIndex = process.argv.indexOf('--home');
const home = homeIndex >= 0 ? process.argv[homeIndex + 1] : process.env.LYNN_HOME;
if (!home || home.startsWith('--')) throw new Error('Specify your Lynn data directory: node install.mjs --home /path/to/lynn-home');
const source = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(path.resolve(home), 'plugins', 'expert-roundtable');
if (fs.existsSync(destination)) throw new Error(`Plugin already exists: ${destination}. Remove or rename that plugin folder before reinstalling.`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
console.log(`Installed expert-roundtable in ${destination}. Restart Lynn to enable it.`);
