"""Deny-by-default tool scopes for task-owned Antigravity invocations.

This is an application guard, not an OS sandbox. URL redirects and remote search
behavior are not observable here; the caller must retain that limitation.
"""
import ipaddress
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
import zlib
from urllib.parse import urlsplit, unquote

BRAIN_ROOT = Path(os.environ.get('USERPROFILE', str(Path.home()))) / '.gemini/antigravity-cli/brain'

RESEARCH_TOOLS = ['search_web', 'read_url_content']
SOURCE_TOOLS = ['view_file', 'list_dir', 'find_by_name', 'grep_search']
MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 4 * 1024 * 1024
SENSITIVE = re.compile(r'(^\.env($|\.)|credential|token|private[-_]?key|^id_(rsa|ed25519)|\.(pem|pfx|p12|key)$)', re.I)


def _plain_path(value, *, must_exist=True):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ValueError('Invalid path')
    # Reject UNC/device/network paths and NTFS alternate data streams before any
    # filesystem probe. The sole supported colon is an absolute drive prefix.
    if value.startswith(('\\\\', '//', '\\??\\')) or ':' in (value[2:] if re.match(r'^[a-zA-Z]:[\\/]', value) else value):
        raise ValueError('Network, device, and alternate-stream paths forbidden')
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Absolute path without traversal required')
    # Do not follow links, including Windows directory junctions/reparse points.
    for item in [path, *path.parents]:
        if item.exists() or item.is_symlink():
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('Link or reparse ancestry forbidden')
    return path.resolve(strict=must_exist)


def _domain(value):
    if not isinstance(value, str) or len(value) > 253 or value != value.strip():
        raise ValueError('Invalid domain')
    domain = value.lower()
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', domain):
        raise ValueError('Invalid domain')
    parts = domain.split('.')
    if len(parts) < 2 or any(not p or len(p) > 63 or p.startswith('-') or p.endswith('-') for p in parts):
        raise ValueError('Public domain required')
    try:
        ipaddress.ip_address(domain)
    except ValueError:
        pass
    else:
        raise ValueError('IP domains forbidden')
    if parts[-1] in {'localhost', 'local', 'internal', 'lan', 'home', 'test', 'invalid', 'example'} or parts[-1].isdigit():
        raise ValueError('Private or reserved domain forbidden')
    return domain


def png_metadata(data):
    """Accept bounded, static, non-interlaced 8-bit RGB/RGBA PNGs only.

    Reject ancillary chunks rather than guessing about animation, embedded data
    or other decoder features. This intentionally narrow transport can expand
    only with separate format validation and genuine native visual acceptance.
    """
    if not isinstance(data, bytes) or len(data) > MAX_FILE or data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Selected image must be a bounded PNG')
    offset, header, compressed, ended, saw_idat = 8, None, bytearray(), False, False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError('Truncated PNG chunk')
        size = struct.unpack('>I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if size > MAX_FILE or end > len(data):
            raise ValueError('Invalid PNG chunk length')
        content = data[offset + 8:end - 4]
        if zlib.crc32(kind + content) & 0xffffffff != struct.unpack('>I', data[end - 4:end])[0]:
            raise ValueError('Invalid PNG checksum')
        if header is None:
            if kind != b'IHDR' or size != 13:
                raise ValueError('PNG header required first')
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', content)
            if (not 1 <= width <= 4096 or not 1 <= height <= 4096 or width * height > MAX_IMAGE_PIXELS
                    or depth != 8 or color not in {2, 6} or (compression, filtering, interlace) != (0, 0, 0)):
                raise ValueError('Unsupported PNG dimensions or encoding')
            header = {'width': width, 'height': height, 'bit_depth': depth, 'color_type': color}
        elif kind == b'IDAT':
            saw_idat = True
            compressed.extend(content)
        elif kind == b'IEND' and size == 0 and saw_idat and end == len(data):
            ended = True
            break
        else:
            raise ValueError('Unsupported PNG chunk or trailing data')
        offset = end
    if not ended:
        raise ValueError('PNG end required')
    stride = header['width'] * (3 if header['color_type'] == 2 else 4) + 1
    expected = stride * header['height']
    decoder = zlib.decompressobj()
    try:
        raw = decoder.decompress(bytes(compressed), expected + 1)
    except zlib.error as exc:
        raise ValueError('Invalid PNG compression') from exc
    if len(raw) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError('Invalid or oversized PNG pixel stream')
    if any(raw[index] > 4 for index in range(0, len(raw), stride)):
        raise ValueError('Invalid PNG row filter')
    return header


def prepare_images(spec, root, policy):
    if set(spec) != {'profile', 'files'} or not isinstance(spec['files'], list) or not 1 <= len(spec['files']) <= 20:
        raise ValueError('Selected images require 1 to 20 explicit PNG files')
    snapshot = root / 'image-snapshot'
    if snapshot.exists():
        raise ValueError('Snapshot already exists')
    pending, names, total = [], set(), 0
    for entry in spec['files']:
        if not isinstance(entry, dict) or set(entry) != {'path', 'name'}:
            raise ValueError('Invalid selected image')
        source = _plain_path(entry['path'])
        name = entry['name']
        if (not isinstance(name, str) or not name or '\\' in name or ':' in name or '\x00' in name
                or PurePosixPath(name).is_absolute()):
            raise ValueError('Invalid image snapshot name')
        parts = name.split('/')
        if any(not part or part in {'.', '..'} or part.endswith(('.', ' '))
               or re.search(r'[<>:"|?*\x00-\x1f]', part)
               or re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part, re.I)
               for part in parts):
            raise ValueError('Unsafe image snapshot filename')
        if any(SENSITIVE.search(x) for x in [*source.parts, *parts]):
            raise ValueError('Sensitive filename forbidden')
        if any(x.lower() in {'agents.md', 'gemini.md', 'context.md', '.agents', '.gemini'} for x in [source.name, *parts]):
            raise ValueError('Instruction files forbidden')
        if source.suffix.lower() != '.png' or PurePosixPath(name).suffix.lower() != '.png':
            raise ValueError('Only PNG images supported')
        folded = name.casefold()
        if any(folded == n or folded.startswith(n + '/') or n.startswith(folded + '/') for n in names):
            raise ValueError('Snapshot name collision')
        names.add(folded)
        if not source.is_file() or source.stat().st_size > MAX_FILE:
            raise ValueError('Selected image too large or not regular')
        data = source.read_bytes()
        metadata = png_metadata(data)
        total += len(data)
        if total > MAX_TOTAL:
            raise ValueError('Selected images exceed total bound')
        pending.append((snapshot / Path(name), data, metadata))
    snapshot.mkdir()
    records = []
    for target, data, metadata in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        records.append({'path': str(target.resolve()), 'sha256': hashlib.sha256(data).hexdigest(),
                        'size': len(data), **metadata})
    policy.update(allowed_tools=['view_file'], snapshot_root=str(snapshot.resolve()),
                  files=[row['path'] for row in records], images=records)
    policy['directories'] = sorted({str(snapshot.resolve()), *[str(p) for target, _, _ in pending
        for p in target.resolve().parents if p == snapshot.resolve() or snapshot.resolve() in p.parents]})
    return policy


def valid_image_policy(policy):
    if set(policy) != {'schema', 'profile', 'allowed_tools', 'allowed_domains', 'files', 'directories', 'snapshot_root', 'images'}:
        return False
    if policy['allowed_tools'] != ['view_file'] or policy['allowed_domains'] != []:
        return False
    root = _plain_path(policy['snapshot_root'])
    records = policy['images']
    if not root.is_dir() or not isinstance(records, list) or not 1 <= len(records) <= 20:
        return False
    files, dirs, total = [], {str(root)}, 0
    for row in records:
        if not isinstance(row, dict) or set(row) != {'path', 'sha256', 'size', 'width', 'height', 'bit_depth', 'color_type'}:
            return False
        if any(type(row[key]) is not int for key in ('size', 'width', 'height', 'bit_depth', 'color_type')):
            return False
        path = _plain_path(row['path'])
        if not path.is_file() or root not in path.parents or path.suffix.lower() != '.png' or path.stat().st_size > MAX_FILE:
            return False
        data = path.read_bytes()
        if (type(row['size']) is not int or len(data) != row['size']
                or hashlib.sha256(data).hexdigest() != row['sha256']
                or png_metadata(data) != {k: row[k] for k in ('width', 'height', 'bit_depth', 'color_type')}):
            return False
        total += len(data)
        files.append(str(path))
        dirs.update(str(p) for p in path.parents if p == root or root in p.parents)
    return (total <= MAX_TOTAL and len(set(files)) == len(files) and policy['files'] == files
            and policy['directories'] == sorted(dirs)
            and all(str(_plain_path(str(p))) in (dirs if p.is_dir() else files) for p in root.rglob('*')))


def prepare(profile_path, cwd):
    """Validate the selected JSON scope and copy only selected UTF-8 files."""
    spec = json.loads(_plain_path(str(profile_path)).read_text(encoding='utf-8-sig'))
    root = _plain_path(str(cwd))
    if not isinstance(spec, dict):
        raise ValueError('Profile must be an object')
    kind = spec.get('profile')
    policy = {'schema': 1, 'profile': kind, 'allowed_tools': [], 'allowed_domains': [], 'files': [], 'directories': []}
    if kind == 'selected-images':
        return prepare_images(spec, root, policy)
    if kind == 'research':
        if not {'profile', 'allowed_domains'} <= set(spec) <= {'profile', 'allowed_domains', 'read_artifacts'} or not isinstance(spec['allowed_domains'], list) or not 1 <= len(spec['allowed_domains']) <= 20:
            raise ValueError('Research requires 1 to 20 exact domains')
        if 'read_artifacts' in spec and type(spec['read_artifacts']) is not bool:
            raise ValueError('read_artifacts must be boolean')
        policy.update(allowed_tools=RESEARCH_TOOLS.copy(), allowed_domains=sorted(set(_domain(x) for x in spec['allowed_domains'])))
        if spec.get('read_artifacts'):
            policy.update(allowed_tools=RESEARCH_TOOLS + ['view_file'], workspace_root=str(root),
                          artifact_registry=str(root / '.agents/fetched-artifacts.json'))
        return policy
    if kind != 'source-review' or set(spec) != {'profile', 'files'} or not isinstance(spec['files'], list) or not 1 <= len(spec['files']) <= 100:
        raise ValueError('Source review requires 1 to 100 selected files')
    snapshot = root / 'source-snapshot'
    if snapshot.exists():
        raise ValueError('Snapshot already exists')
    pending, names, total = [], set(), 0
    for entry in spec['files']:
        if not isinstance(entry, dict) or set(entry) != {'path', 'name'}:
            raise ValueError('Invalid selected file')
        source = _plain_path(entry['path'])
        name = entry['name']
        if not isinstance(name, str) or '\\' in name or ':' in name or '\x00' in name:
            raise ValueError('Invalid snapshot name')
        relative = PurePosixPath(name)
        if relative.is_absolute() or not relative.parts or any(x in {'.', '..'} for x in name.split('/')):
            raise ValueError('Snapshot traversal forbidden')
        if any(not part or part.endswith(('.', ' ')) or re.search(r'[<>:"|?*\x00-\x1f]', part)
               or re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part, re.I)
               for part in name.split('/')):
            raise ValueError('Unsafe snapshot filename')
        if any(SENSITIVE.search(x) for x in [*source.parts, *relative.parts]):
            raise ValueError('Sensitive filename forbidden')
        if any(x.lower() in {'agents.md', 'gemini.md', 'context.md', '.agents', '.gemini'} for x in [source.name, *relative.parts]):
            raise ValueError('Instruction files forbidden')
        mapped = relative.as_posix() + '.txt'
        folded = mapped.casefold()
        # Reject file/dir prefix collisions even on case-sensitive hosts.
        if any(folded == n or folded.startswith(n + '/') or n.startswith(folded + '/') for n in names):
            raise ValueError('Snapshot name collision')
        names.add(folded)
        if not source.is_file() or source.stat().st_size > MAX_FILE:
            raise ValueError('Selected file too large or not regular')
        data = source.read_bytes()
        if len(data) > MAX_FILE or b'\x00' in data:
            raise ValueError('Selected file is not bounded text')
        data.decode('utf-8-sig', errors='strict')
        total += len(data)
        if total > MAX_TOTAL:
            raise ValueError('Selected files exceed total bound')
        pending.append((snapshot / Path(mapped), data))
    snapshot.mkdir()
    for target, data in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    policy.update(allowed_tools=SOURCE_TOOLS.copy(), snapshot_root=str(snapshot.resolve()), files=[str(p.resolve()) for p, _ in pending])
    dirs = {snapshot.resolve()}
    for path, _ in pending:
        dirs.update(p for p in path.resolve().parents if p == snapshot.resolve() or snapshot.resolve() in p.parents)
    policy['directories'] = sorted(str(p) for p in dirs)
    return policy


def _valid_policy(policy):
    if not isinstance(policy, dict) or policy.get('schema') != 1:
        return False
    if policy.get('profile') == 'selected-images':
        return valid_image_policy(policy)
    if policy.get('profile') == 'research':
        domains = policy.get('allowed_domains')
        tools = policy.get('allowed_tools')
        registry_ok = (tools == RESEARCH_TOOLS or
            (tools == RESEARCH_TOOLS + ['view_file'] and
             Path(policy['artifact_registry']) == _plain_path(policy['workspace_root']) / '.agents/fetched-artifacts.json'))
        return registry_ok and isinstance(domains, list) and 1 <= len(domains) <= 20 and all(_domain(x) == x for x in domains)
    if policy.get('profile') != 'source-review' or policy.get('allowed_tools') != SOURCE_TOOLS:
        return False
    root = _plain_path(policy['snapshot_root'])
    files, dirs = policy['files'], policy['directories']
    return (isinstance(files, list) and 1 <= len(files) <= 100 and isinstance(dirs, list)
            and str(root) in dirs
            and all((p := _plain_path(x)).is_file() and root in p.parents for x in files)
            and all((p := _plain_path(x)).is_dir() and (p == root or root in p.parents) for x in dirs)
            and all(str(_plain_path(str(p))) in (dirs if p.is_dir() else files) for p in root.rglob('*')))


def decide(name, args, policy):
    """Return True only for a recognized tool operating within its explicit scope."""
    try:
        if not _valid_policy(policy) or not isinstance(args, dict) or name not in policy['allowed_tools']:
            return False
        args = dict(args)
        # CLI1.4.3 adds UI descriptions to every native tool call. They cannot
        # select a resource or grant a capability; validate and discard only
        # these two observed fields before exact operation-argument checks.
        for key in ('toolAction', 'toolSummary'):
            if key in args:
                if not isinstance(args[key], str) or len(args[key]) > 4000:
                    return False
                args.pop(key)
        if policy['profile'] == 'selected-images':
            # Native image viewing needs a path only. Text ranges, summaries and
            # skill interpretation are deliberately unavailable for this scope.
            return (name == 'view_file' and set(args) == {'AbsolutePath'} and
                    str(_plain_path(args['AbsolutePath'])) in policy['files'])
        if policy['profile'] == 'research':
            if name == 'view_file':
                return artifact_read_allowed(args, policy)
            if name == 'search_web':
                return (set(args) <= {'query', 'domain'} and set(args) >= {'query', 'domain'}
                        and isinstance(args['query'], str) and 1 <= len(args['query'].strip()) <= 2000
                        and not any(ord(c) < 32 for c in args['query'])
                        and _domain(args['domain']) in policy['allowed_domains'])
            if set(args) not in ({'url'}, {'Url'}):
                return False
            value = next(iter(args.values()))
            if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 33 for c in value):
                return False
            url = urlsplit(value)
            return (url.scheme == 'https' and url.username is None and url.password is None
                    and url.port in {None, 443} and _domain(url.hostname) in policy['allowed_domains'])
        keys = {'view_file': ('AbsolutePath', {'AbsolutePath', 'StartLine', 'EndLine', 'IncludeSummaryOfOtherChunks', 'IsSkillFile'}),
                'list_dir': ('DirectoryPath', {'DirectoryPath'}),
                'find_by_name': ('SearchDirectory', {'SearchDirectory', 'Pattern', 'Excludes', 'Extensions', 'FullPath', 'MaxDepth', 'Type'}),
                'grep_search': ('SearchPath', {'SearchPath', 'Query', 'CaseInsensitive', 'Includes', 'IsRegex', 'MatchPerLine'})}
        path_key, allowed_keys = keys[name]
        if path_key not in args or not set(args) <= allowed_keys:
            return False
        if 'IsSkillFile' in args and args['IsSkillFile'] is not False:
            return False
        for key, value in args.items():
            if key in {'StartLine', 'EndLine', 'MaxDepth'} and (type(value) is not int or not 0 <= value <= 1000000):
                return False
            if key in {'IncludeSummaryOfOtherChunks', 'FullPath', 'CaseInsensitive', 'IsRegex', 'MatchPerLine'} and type(value) is not bool:
                return False
            if key in {'Pattern', 'Type', 'Query'} and (not isinstance(value, str) or not value or len(value) > 2000):
                return False
            if key in {'Excludes', 'Extensions', 'Includes'} and (not isinstance(value, list) or len(value) > 100 or any(not isinstance(x, str) or len(x) > 2000 for x in value)):
                return False
        path = _plain_path(args[path_key])
        if name == 'view_file':
            return path.is_file() and str(path) in policy['files']
        if name in {'list_dir', 'find_by_name'}:
            return path.is_dir() and str(path) in policy['directories']
        return str(path) in policy['files'] or str(path) in policy['directories']
    except (ValueError, TypeError, KeyError, OSError, AttributeError):
        return False


def artifact_records(policy):
    path = Path(policy['artifact_registry'])
    if not path.exists():
        return []
    path = _plain_path(str(path))
    if path.stat().st_size > 256 * 1024:
        raise ValueError('Artifact registry too large')
    rows = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(rows, list) or len(rows) > 100:
        raise ValueError('Invalid artifact registry')
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'conversation_id','step','url','path','sha256'}:
            raise ValueError('Invalid artifact record')
        if not isinstance(row['conversation_id'], str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', row['conversation_id']):
            raise ValueError('Invalid artifact conversation')
        if type(row['step']) is not int or not 0 <= row['step'] <= 100000:
            raise ValueError('Invalid artifact step')
        expected = BRAIN_ROOT / row['conversation_id'] / '.system_generated/steps' / str(row['step']) / 'content.md'
        if Path(row['path']) != expected or not re.fullmatch(r'[0-9a-f]{64}', row['sha256']):
            raise ValueError('Invalid artifact path or hash')
        if not decide('read_url_content', {'Url': row['url']}, policy):
            raise ValueError('Artifact origin outside scope')
    return rows


def workspace_bound(event, policy):
    expected = _plain_path(policy['workspace_root'])
    values = event.get('workspacePaths')
    # Fresh headless sessions may have no registered project workspace. The
    # trusted hook still must execute in the exact parent-owned run directory.
    if values == []:
        return _plain_path(os.getcwd()) == expected
    if not isinstance(values,list) or len(values) != 1 or not isinstance(values[0],str):
        return False
    value = values[0]
    if value.startswith('file:'):
        uri = urlsplit(value)
        if uri.scheme != 'file' or uri.netloc or uri.query or uri.fragment:
            return False
        value = unquote(uri.path,errors='strict')
        if re.match(r'^/[a-zA-Z]:/',value):
            value = value[1:]
    return _plain_path(value) == expected


def register_artifact(policy, event):
    """Bind a fetch to trusted native PostToolUse metadata, never a model path."""
    if 'artifact_registry' not in policy:
        return
    conversation = event.get('conversationId')
    step = event.get('stepIdx')
    if not isinstance(conversation, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', conversation):
        raise ValueError('Invalid native conversation')
    if type(step) is not int or not 0 <= step <= 100000:
        raise ValueError('Invalid native step')
    root = _plain_path(str(BRAIN_ROOT / conversation))
    if _plain_path(event['artifactDirectoryPath']) != root:
        raise ValueError('Native artifact root mismatch')
    if not workspace_bound(event,policy):
        raise ValueError('Native workspace mismatch')
    path = _plain_path(str(root / '.system_generated/steps' / str(step) / 'content.md'))
    if not path.is_file() or path.stat().st_size > MAX_FILE:
        raise ValueError('Artifact not bounded text')
    content = path.read_bytes()
    content.decode('utf-8-sig')
    if len(content) > MAX_FILE or b'\x00' in content:
        raise ValueError('Artifact not bounded text')
    args = event['toolCall']['args']
    url = args.get('Url', args.get('url'))
    row = {'conversation_id':conversation,'step':step,'url':url,'path':str(path),
           'sha256':hashlib.sha256(content).hexdigest()}
    records = artifact_records(policy)
    if any(x['conversation_id'] != conversation for x in records):
        raise ValueError('Cross-conversation artifact forbidden')
    records = [x for x in records if x['step'] != step] + [row]
    if len(records) > 100:
        raise ValueError('Too many artifacts')
    destination = Path(policy['artifact_registry'])
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.tmp')
    temporary.write_text(json.dumps(records, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, destination)


def artifact_read_allowed(args, policy):
    if not set(args) <= {'AbsolutePath','StartLine','EndLine','IncludeSummaryOfOtherChunks','IsSkillFile'} or 'AbsolutePath' not in args:
        return False
    if 'IsSkillFile' in args and args['IsSkillFile'] is not False:
        return False
    for key in ('StartLine','EndLine'):
        if key in args and (type(args[key]) is not int or not 0 <= args[key] <= 1000000):
            return False
    if 'IncludeSummaryOfOtherChunks' in args and type(args['IncludeSummaryOfOtherChunks']) is not bool:
        return False
    path = _plain_path(args['AbsolutePath'])
    return any(str(path) == r['path'] and path.stat().st_size <= MAX_FILE and
               hashlib.sha256(path.read_bytes()).hexdigest() == r['sha256'] for r in artifact_records(policy))


def main():
    name, allowed = 'UNKNOWN', False
    post = len(sys.argv) == 4 and sys.argv[3] == '--post'
    success = False
    try:
        policy = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        event = json.loads(sys.stdin.read(1024 * 1024))
        call = event.get('toolCall', {})
        candidate = call.get('name')
        if isinstance(candidate, str) and re.fullmatch(r'[a-zA-Z0-9_.:/-]{1,128}', candidate):
            name = candidate
            allowed = decide(name, call.get('args'), policy)
            error = event.get('error', '')
            success = allowed and isinstance(error, str) and not error
            if post and success and name == 'read_url_content':
                register_artifact(policy, event)
    except (ValueError, OSError, IndexError, TypeError, AttributeError, KeyError) as exc:
        success = False
        if post and name == 'read_url_content' and isinstance(policy,dict) and 'artifact_registry' in policy:
            # Metadata only: never persist the query, URL, page body or raw error.
            try:
                known = {'Invalid native conversation','Invalid native step','Native artifact root mismatch',
                         'Native workspace mismatch','Artifact not bounded text','Cross-conversation artifact forbidden'}
                diagnostic = {'error_type':type(exc).__name__,
                    'reason':str(exc) if str(exc) in known else 'ARTIFACT_REGISTRATION_FAILED',
                    'event_keys':sorted(event) if isinstance(event,dict) else [],
                    'workspace_matches':workspace_bound(event,policy),
                    'workspace_count':len(event['workspacePaths']) if isinstance(event.get('workspacePaths'),list) else None,
                    'step_type':type(event.get('stepIdx')).__name__,
                    'artifact_root_type':type(event.get('artifactDirectoryPath')).__name__}
                Path(policy['artifact_registry']).with_name('artifact-registration-diagnostic.json').write_text(json.dumps(diagnostic),encoding='utf-8')
            except (OSError,ValueError,KeyError,TypeError,AttributeError):
                pass
    decision = 'allow' if allowed else 'deny'
    try:
        with Path(sys.argv[2]).open('a', encoding='utf-8') as audit:
            audit.write(json.dumps({'tool_name': name, 'completed': True, 'success': success}
                                   if post else {'tool_name': name, 'decision': decision}) + '\n')
    except (OSError, IndexError):
        print(json.dumps({} if post else {'decision': 'deny', 'reason': 'Tool audit unavailable.'}), flush=True)
        return 1
    # The caller explicitly selected this bounded read scope. Headless requests
    # cannot answer a new interactive permission prompt. The documented scoped
    # auto_approve decision honors explicit vendor deny rules; no global grant.
    print(json.dumps({} if post else {'decision': 'auto_approve' if allowed else 'deny',
                                     'reason': 'Parent-selected scoped read policy.'}), flush=True)
    return 0


if __name__ == '__main__':
    # Native CLI hook events are UTF-8 even when Windows pipes default to ANSI.
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
