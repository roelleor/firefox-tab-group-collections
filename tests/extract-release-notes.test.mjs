import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAmoMetadata,
  extractReleaseNotesFromText,
} from '../scripts/extract-release-notes.mjs';

const changelogText = `Tab Group Collections Changelog

Format: plain text, based on Keep a Changelog.

1.1.0 - 2026-04-14

Added
- Dedicated Uncategorized bucket for groups kept after deleting a collection only.

Changed
- Live groups now use a small filled square marker.

1.0.0 - 2026-04-14

Added
- Initial stable release.
`;

test('extractReleaseNotesFromText returns the matching version body only', () => {
  const notes = extractReleaseNotesFromText(changelogText, '1.1.0');

  assert.equal(
    notes,
    [
      'Added',
      '- Dedicated Uncategorized bucket for groups kept after deleting a collection only.',
      '',
      'Changed',
      '- Live groups now use a small filled square marker.',
    ].join('\n'),
  );
});

test('extractReleaseNotesFromText throws when the version is missing', () => {
  assert.throws(
    () => extractReleaseNotesFromText(changelogText, '9.9.9'),
    /Could not find changelog entry for 9\.9\.9\./,
  );
});

test('extractReleaseNotesFromText throws when the version entry is empty', () => {
  const invalidChangelog = `1.2.0 - 2026-04-14
1.1.0 - 2026-04-14

Added
- Something here.
`;

  assert.throws(
    () => extractReleaseNotesFromText(invalidChangelog, '1.2.0'),
    /Changelog entry for 1\.2\.0 is empty\./,
  );
});

test('buildAmoMetadata wraps release notes in the AMO metadata shape', () => {
  assert.deepEqual(buildAmoMetadata('Added\n- Test item'), {
    version: {
      release_notes: {
        'en-US': 'Added\n- Test item',
      },
    },
  });
});
