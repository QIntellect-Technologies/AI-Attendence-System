import sys
sys.path.append('.')
from dotenv import load_dotenv
load_dotenv()
from support_db import get_supabase
sb = get_supabase()
staff = sb.table('client_staff').select('name, department_name, department_id').execute().data
for s in staff:
    if s.get('department_name') == '' or s.get('department_name') == 'Developer':
        print(f"{s.get('name')}: '{s.get('department_name')}', {s.get('department_id')}")
