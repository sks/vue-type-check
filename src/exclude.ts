#!/usr/bin/env node
let finalCmd: string[] = []; 
process.argv.forEach((val, index) => {
    if (index > 1 && val.endsWith('.vue')) { finalCmd.push(`--excludeDir ${val}`); }
});
console.log(finalCmd.join(' '));
process.exit(0)
