"""Explicit capability status and exhaustive observed-tool classification."""
import json
from pathlib import Path

TOOL_CLASSES = {
    'selected_read': {'view_file','list_dir','find_by_name','grep_search','sed_file'},
    'public_research': {'search_web','read_url_content'},
    'workspace_write': {'write_to_file','replace_file_content','multi_replace_file_content'},
    'execution': {'run_command','command_status','send_command_input','notebook_execution','notebook_edit'},
    'browser': {'browser_subagent','browser_click_element','browser_drag_pixel_to_pixel','browser_get_dom',
        'browser_get_network_request','browser_input','browser_list_network_requests','browser_mouse_down',
        'browser_mouse_up','browser_move_mouse','browser_press_key','browser_refresh_page','browser_resize_window',
        'browser_scroll','browser_scroll_dom','browser_select_option','capture_browser_console_logs',
        'capture_browser_screenshot','click_browser_pixel','execute_browser_javascript','list_browser_pages',
        'open_browser_url','read_browser_page'},
    'delegation': {'invoke_subagent','define_subagent','manage_subagents'},
    'integration': {'call_mcp_tool','list_resources','read_resource','list_plugin_accounts','search_marketplace'},
    'image_generation': {'generate_image'},
    'external_or_persistent': {'send_message','schedule','run_workflow','manage_inbox','delete_knowledge','manage_task'},
    'permission_control': {'ask_custom_permission','ask_permission','list_permissions'},
    'interaction': {'ask_question','finish','wait','wait_5_seconds'},
}


def classify(names):
    if not isinstance(names, list) or any(not isinstance(x,str) for x in names):
        raise ValueError('Invalid native tool inventory')
    return [{'tool':name,'category':next((k for k,v in TOOL_CLASSES.items() if name in v),'unknown'),
             'access':'requires_explicit_accepted_scope'} for name in sorted(set(names))]


def describe(root, current, reasoning=False, readonly=False, observation=None):
    if observation is not None:
        identity_key=json.dumps(current,sort_keys=True,separators=(',',':'))
        return observation.memo(('capabilities',str(Path(root)),identity_key,reasoning,readonly),
            lambda: describe(root,current,reasoning,readonly))
    evidence_path = Path(root) / 'capability-evidence.json'
    evidence = json.loads(evidence_path.read_text(encoding='utf-8'))
    matches = evidence.get('cli_sha256') == current['cli_sha256']
    blockers = evidence.get('blockers', {}) if matches else {}
    unavailable = 'CLI_IDENTITY_REQUIRES_CAPABILITY_REASSESSMENT'
    result = {'reasoning': {'enabled': reasoning},
              'source_review': {'enabled':readonly}, 'public_research': {'enabled':readonly},
              'context_preparation': {'enabled':True,'scope':'selected_local_documents'},
              'structured_results': {'enabled':True,'scope':'validation_only_no_application'}}
    for name in ('workspace_execution','workspace_edits','notebooks','browser','delegation','visual_inputs','image_generation','mcp'):
        result[name] = {'enabled':False,'blocker':blockers.get(name, 'CAPABILITY_NOT_ACCEPTED') if matches else unavailable}
    return {'capabilities':result, 'evidence_identity_matches':matches,
            'workspace_profile_enabled':False}


def workspace_request(path, root, current):
    """Recognize workspace scope explicitly; never downgrade it silently."""
    spec = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if not isinstance(spec,dict) or spec.get('profile') != 'workspace':
        return None
    allowed = {'profile','files','allowed_domains','integrations','expected_result'}
    if set(spec) - allowed or not isinstance(spec.get('files',[]),list) or not isinstance(spec.get('allowed_domains',[]),list) or not isinstance(spec.get('integrations',[]),list):
        raise ValueError('Invalid workspace specification')
    state = describe(root,current)
    return {'status':'BLOCKED','error_code':'WORKSPACE_CAPABILITY_UNAVAILABLE',
            'error':'Workspace execution/editing is not accepted on this runtime. Select an accepted read-only profile explicitly.',
            'submission_state':'not_submitted','provider_request_started':False, **state}
