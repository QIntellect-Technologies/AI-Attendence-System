import sys
sys.path.append('.')
from dotenv import load_dotenv
load_dotenv()
from support_db import get_supabase
sb = get_supabase()

depts = sb.table('departments').select('*').execute().data
dept_map = {d['id']: d['name'] for d in depts if d.get('name')}

staff = sb.table('client_staff').select('id, name, department_name, department_id').execute().data
for s in staff:
    did = s.get('department_id')
    if did in dept_map:
        name = dept_map[did]
        if s.get('department_name') != name:
            print(f"Updating {s['name']}: {s.get('department_name')} -> {name}")
            sb.table('client_staff').update({'department_name': name}).eq('id', s['id']).execute()
print("Done")
