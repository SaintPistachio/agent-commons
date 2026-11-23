"""Parent-owned PostInvocation completion for a selected text-only contract."""
import json
import sys

def main():
    try:
        event=json.loads(sys.stdin.read(1024*1024))
        if not isinstance(event,dict) or type(event.get('invocationNum')) is not int or event['invocationNum']<0:
            raise ValueError('Invalid invocation metadata')
        print(json.dumps({'injectSteps':[],'terminationBehavior':'terminate'}),flush=True)
        return 0
    except (ValueError,OSError,TypeError):
        print('{}',flush=True)
        return 1

if __name__=='__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
