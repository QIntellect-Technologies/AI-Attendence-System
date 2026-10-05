import sys
sys.path.append('.')
from dotenv import load_dotenv
load_dotenv()
from support_db import get_supabase
sb = get_supabase()
depts = sb.table('departments').select('*').execute().data
dept_map = {d['id']: d['name'] for d in depts if d.get('name')}
staff = sb.table('client_staff').select('name, department_name, department_id').execute().data
for s in staff:
    did = s.get('department_id')
    if did in dept_map and dept_map[did] == 'Q/A':
        print(f"{s['name']} is in Q/A!")
