export function patchResponse(prompt) {
  if (!prompt.includes('PATCH-EDIT-FIXTURE')) return null;
  if (prompt.includes('PATCH-ESCAPE-FIXTURE'))
    return '<<<FILE ../outside.txt\nforbidden\n>>>END\n@air1\n#0 chk verdict=ok "patch"';
  const revised = prompt.includes('approved-check-failure-marker');
  if (prompt.includes('PATCH-EXCERPTS-FIXTURE')) {
    if (!revised) return `<<<FILE first.txt\n${'x'.repeat(13500)}\n>>>END\n<<<FILE later.txt\nlater draft\n>>>END\n@air1\n#0 chk verdict=ok "patch"`;
    if (!prompt.includes('later.txt\nlater draft')) throw new Error('revision omitted the later file');
    return '<<<EDIT later.txt\n<<<OLD\nlater draft\n>>>NEW\nlater verified\n>>>END\n@air1\n#0 chk verdict=ok "patch"';
  }
  if (revised && !prompt.includes('draft answer')) throw new Error('revision did not receive the refreshed file');
  const before = revised ? 'draft answer' : 'committed original';
  const after = revised ? 'verified answer' : 'draft answer';
  return `<<<EDIT README.md\n<<<OLD\n${before}\n>>>NEW\n${after}\n>>>END\n@air1\n#0 chk verdict=ok "patch"`;
}
