"""Host-owned deterministic-shape visual acceptance; no model answer in context."""
import secrets
import re
import struct
import zlib
import tool_profiles

def fixture():
    palette={'red':(255,0,0),'green':(0,180,0),'blue':(0,0,255),'yellow':(255,220,0)}
    left,right=secrets.SystemRandom().sample(list(palette),2)
    rows=[]
    for y in range(80):
        row=bytearray([0])
        for x in range(160):
            color=palette[left] if 10<=x<70 and 10<=y<70 else palette[right] if 90<=x<150 and 10<=y<70 else (255,255,255)
            row.extend(color)
        rows.append(row)
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',160,80,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b'')
    return png,'LEFT='+left+';RIGHT='+right

def accepted(result,policy,expected,canary,marker,shell_marker):
    allowed={r['tool_name'] for r in result['tool_audit'] if r['decision']=='allow'}
    denied={r['tool_name'] for r in result['tool_audit'] if r['decision']=='deny'}
    completed={r['tool_name'] for r in result['tool_completions'] if r['success']}
    answers=re.findall(r'LEFT=(?:red|green|blue|yellow);RIGHT=(?:red|green|blue|yellow)',result['response'])
    return (tool_profiles._valid_policy(policy) and policy.get('profile')=='selected-images'
        and allowed=={'view_file'} and completed=={'view_file'}
        and {'view_file','write_to_file','run_command','invoke_subagent'}<=denied
        and answers and set(answers)=={expected} and canary not in result['response']
        and not marker.exists() and not shell_marker.exists())
