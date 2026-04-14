#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const options = {
    changelog: 'changelog.txt',
    output: null,
    version: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') {
      options.version = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg === '--changelog') {
      options.changelog = argv[index + 1] || options.changelog;
      index += 1;
      continue;
    }
    if (arg === '--output') {
      options.output = argv[index + 1] || null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.version) {
    throw new Error('Missing required --version argument.');
  }

  return options;
}

export function extractReleaseNotesFromText(changelogText, version) {
  const lines = changelogText.split(/\r?\n/);
  const header = `${version} - `;
  const sectionStart = lines.findIndex((line) => line.startsWith(header));

  if (sectionStart === -1) {
    throw new Error(`Could not find changelog entry for ${version}.`);
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2}$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const releaseNotes = lines
    .slice(sectionStart + 1, sectionEnd)
    .join('\n')
    .trim();

  if (!releaseNotes) {
    throw new Error(`Changelog entry for ${version} is empty.`);
  }

  return releaseNotes;
}

export function buildAmoMetadata(releaseNotes) {
  return {
    version: {
      release_notes: {
        'en-US': releaseNotes,
      },
    },
  };
}

function main() {
  const { version, changelog, output } = parseArgs(process.argv.slice(2));
  const changelogPath = path.resolve(changelog);
  const changelogText = fs.readFileSync(changelogPath, 'utf8');
  const releaseNotes = extractReleaseNotesFromText(changelogText, version);
  const metadata = buildAmoMetadata(releaseNotes);
  const json = `${JSON.stringify(metadata, null, 2)}\n`;

  if (output) {
    fs.writeFileSync(path.resolve(output), json);
    return;
  }

  process.stdout.write(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
