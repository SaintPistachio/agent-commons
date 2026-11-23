/** Keep Git from importing process-level config, repository redirects, or transport commands. */
export function jobGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
    ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}),
  };
}
