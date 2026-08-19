"""
support_routes.py
──────────────────────────────────────────────────────────────────────────────
All /v1/support/* Flask routes for the Support Dashboard.

Keep only Flask route handlers in this file. Supabase query/business logic stays
in support_db.py.
"""

from flask import Blueprint, request, jsonify, g, send_file
from support_auth import require_support_auth, require_capability, login_internal_user
import support_db as db
import login_throttle
from logger_config import get_logger
from pathlib import Path
from supabase_client import get_supabase
from installer_packager import (
    build_node_installer_exe,
    build_node_installer_zip,
    node_exe_installer_filename,
    node_installer_filename,
)
from io import BytesIO
from flask import send_file
from support_invoice_delivery import (
    build_invoice_delivery_message,
    build_invoice_pdf,
    mark_invoice_sent_manually,
)

logger = get_logger(__name__)

support_bp = Blueprint("support", __name__, url_prefix="/v1/support")


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _ok(data, status=200):
    return jsonify({"success": True, **data}), status


def _err(message, status=400):
    return jsonify({"success": False, "error": message, "message": message}), status


def _handle(fn):
    """Wrap route body and keep predictable Flask envelopes."""
    try:
        return fn()
    except ValueError as e:
        logger.warning(f"Support route validation error: {e}")
        return _err(str(e), 400)
    except RuntimeError as e:
        logger.error(f"Support route runtime error: {e}")
        return _err(str(e), 500)
    except Exception as e:
        logger.exception(f"Support route unexpected error: {e}")
        return _err("Internal server error", 500)


# ═════════════════════════════════════════════════════════════
# AUTH
# ═════════════════════════════════════════════════════════════

@support_bp.route("/auth/login", methods=["POST"])
def support_login():
    """Authenticate an internal support user and return a JWT."""
    def _run():
        data = request.get_json(silent=True) or {}
        email = str(data.get("email") or "").strip().lower()
        password = str(data.get("password") or "")

        if not email or not password:
            return _err("Email and password are required", 400)

        # Same brute-force throttle as /api/login. This one guards the
        # internal support accounts, which are the highest-privilege
        # identities in the system (cross-tenant), so it is the last place
        # that should have been left unlimited. See login_throttle.py.
        if login_throttle.is_locked_out(email):
            return login_throttle.lockout_response(email)

        try:
            user, token = login_internal_user(email, password)
        except Exception:
            login_throttle.register_failure(email)
            raise
        login_throttle.register_success(email)
        return _ok({"user": user, "token": token})

    return _handle(_run)


@support_bp.route("/auth/me", methods=["GET"])
@require_support_auth
def support_me():
    """Return the authenticated internal user's full profile."""
    def _run():
        user = db.get_internal_user_by_id(g.support_user["id"])
        return _ok({"user": user})

    return _handle(_run)


# ═════════════════════════════════════════════════════════════
# ORGANIZATIONS
# ═════════════════════════════════════════════════════════════

@support_bp.route("/vertical-templates", methods=["GET"])
@require_support_auth
def list_vertical_templates():
    """
    Support Dashboard dropdown for business templates.
    Client Dashboard can read tenant config but cannot edit templates.
    """
    def _run():
        templates = db.list_vertical_templates()
        return _ok({"templates": templates})

    return _handle(_run)

@support_bp.route("/organizations", methods=["GET"])
@require_capability("orgs:read")
def list_organizations():
    def _run():
        orgs = db.list_organizations(
            status=request.args.get("status"),
            search=request.args.get("search") or request.args.get("q"),
            business_type=request.args.get("business_type"),
            include_archived=True,
            include_deleted=False,
        )
        return _ok({"organizations": orgs})

    return _handle(_run)


@support_bp.route("/organizations", methods=["POST"])
@require_capability("orgs:write")
def create_organization():
    """Create an organization. Branches/modules/billing are separate steps."""
    def _run():
        payload = request.get_json(silent=True) or {}

        required = ["name", "contact_email", "attendance_mode", "max_branches"]
        missing = [field for field in required if not payload.get(field)]
        if missing:
            return _err(f"Missing required fields: {', '.join(missing)}", 400)

        org = db.create_organization(payload, created_by=g.support_user["id"])
        return _ok({"organization": org}, 201)

    return _handle(_run)


@support_bp.route("/organizations/<org_id>", methods=["GET"])
@require_capability("orgs:read")
def get_organization(org_id):
    def _run():
        org = db.get_organization(org_id)
        return _ok({"organization": org})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>", methods=["PATCH"])
@require_capability("orgs:write")
def update_organization(org_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        payload["updated_by"] = g.support_user["id"]
        org = db.update_organization(org_id, payload)
        return _ok({"organization": org})

    return _handle(_run)

@support_bp.route("/organizations/<org_id>/template", methods=["PATCH", "PUT"])
@require_capability("orgs:write")
def update_organization_template(org_id):
    """
    Support-only endpoint.

    Updates only support-owned vertical/template fields.
    Client Dashboard must never call this.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        business_type = str(payload.get("business_type") or "").strip().lower()

        if not business_type:
            return _err("business_type is required", 400)

        attendance_people_types = payload.get("attendance_people_types")

        org = db.update_organization_template(
            org_id=org_id,
            business_type=business_type,
            attendance_people_types=attendance_people_types,
            updated_by=g.support_user["id"],
        )
        return _ok({"organization": org})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/staff-type-scope", methods=["PATCH", "PUT"])
@require_capability("orgs:write")
def update_organization_staff_type_scope(org_id):
    """
    Support-only endpoint.

    Sets which staff work types (office/field) this org is commercially
    entitled to add via the Client Dashboard's Staff Management. Client
    Dashboard must never call this — same contract as the template route.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        enabled_staff_types = payload.get("enabled_staff_types")

        if not isinstance(enabled_staff_types, list) or not enabled_staff_types:
            return _err("enabled_staff_types must be a non-empty array", 400)

        org = db.update_organization_staff_type_scope(
            org_id=org_id,
            enabled_staff_types=enabled_staff_types,
            updated_by=g.support_user["id"],
        )
        return _ok({"organization": org})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/archive", methods=["PATCH"])
@require_capability("orgs:lifecycle")
def archive_organization(org_id):
    """Archive an organization without deleting tenant data."""
    def _run():
        payload = request.get_json(silent=True) or {}
        org = db.archive_organization(
            org_id=org_id,
            archived_by=g.support_user["id"],
            reason=payload.get("reason"),
            retention_years=int(payload.get("retention_years") or 5),
        )
        return _ok({"organization": org})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/restore", methods=["PATCH"])
@require_capability("orgs:lifecycle")
def restore_organization(org_id):
    """Restore an archived organization. Billing status remains invoice-based."""
    def _run():
        org = db.restore_organization(
            org_id=org_id,
            restored_by=g.support_user["id"],
        )
        return _ok({"organization": org})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/retention-policy", methods=["PATCH"])
@require_capability("orgs:lifecycle")
def update_organization_retention_policy(org_id):
    """Update organization-level data retention policy."""
    def _run():
        payload = request.get_json(silent=True) or {}
        years = int(payload.get("retention_years") or payload.get("organization_retention_years") or 5)
        org = db.update_organization_retention_policy(
            org_id=org_id,
            retention_years=years,
            updated_by=g.support_user["id"],
        )
        return _ok({"organization": org})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/request-delete", methods=["POST"])
@require_capability("orgs:lifecycle")
def request_organization_delete(org_id):
    """Request permanent deletion. Does not delete data."""
    def _run():
        payload = request.get_json(silent=True) or {}
        org = db.request_organization_delete(
            org_id=org_id,
            requested_by=g.support_user["id"],
            reason=payload.get("reason"),
        )
        return _ok({"organization": org})

    return _handle(_run)


def _support_user_is_super_admin() -> bool:
    user_id = (g.support_user or {}).get("id")
    role = str((g.support_user or {}).get("role") or "").strip().lower()
    if role == "super_admin":
        return True
    if not user_id:
        return False
    try:
        current_user = db.get_internal_user_by_id(user_id)
        return str(current_user.get("role") or "").strip().lower() == "super_admin"
    except Exception:
        return False


@support_bp.route("/organizations/<org_id>/permanent", methods=["DELETE", "POST"])
@support_bp.route("/organizations/<org_id>/permanent-delete", methods=["POST"])
@require_capability("orgs:delete")
def permanently_delete_organization(org_id):
    """
    Permanently delete tenant data. Super-admin only.

    Supports:
      - DELETE /v1/support/organizations/<org_id>/permanent
      - POST   /v1/support/organizations/<org_id>/permanent-delete

    The POST alias is intentional for browser/proxy-safe destructive actions:
    some local/proxy stacks mishandle DELETE requests with JSON bodies, while
    this endpoint still requires support JWT, super_admin role, exact org-name
    confirmation, and server-side tenant scoping.
    """
    def _run():
        if not _support_user_is_super_admin():
            return _err(
                "Permanent deletion requires super_admin approval. "
                "Use 'Request Delete' to submit this organization for super_admin review.",
                403,
            )

        payload = request.get_json(silent=True) or {}
        result = db.permanently_delete_organization(
            org_id=str(org_id),
            deleted_by=g.support_user["id"],
            confirm_name=payload.get("confirm_name"),
            reason=payload.get("reason"),
        )
        return _ok({"deleted": result})

    return _handle(_run)


# ═════════════════════════════════════════════════════════════
# BRANCHES
# ═════════════════════════════════════════════════════════════

@support_bp.route("/organizations/<org_id>/branches", methods=["GET"])
@require_capability("branches:read")
def list_branches(org_id):
    def _run():
        include_dropped = str(
            request.args.get("include_dropped")
            or request.args.get("includeDropped")
            or ""
        ).strip().lower() in {"1", "true", "yes"}
        branches = db.list_branches(org_id, include_dropped=include_dropped)
        return _ok({"branches": branches})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/branches", methods=["POST"])
@require_capability("branches:write")
def create_branch(org_id):
    """Create a support-owned branch after enforcing org max_branches."""
    def _run():
        payload = request.get_json(silent=True) or {}
        payload["org_id"] = org_id

        if not payload.get("name"):
            return _err("Branch name is required", 400)

        branch = db.create_branch(payload)
        return _ok({"branch": branch}, 201)

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/branches/<branch_id>", methods=["PATCH"])
@require_capability("branches:write")
def update_organization_branch(org_id, branch_id):
    """Update one branch after verifying it belongs to this organization."""
    def _run():
        payload = request.get_json(silent=True) or {}
        branch = db.update_branch(branch_id, payload, org_id=org_id)
        return _ok({"branch": branch})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/branches/<branch_id>/module-people-types", methods=["GET"])
@require_capability("branches:read")
def get_branch_module_people_types(org_id, branch_id):
    def _run():
        config = db.list_branch_module_people_types(org_id, branch_id)
        return _ok({"module_people_types": config})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/branches/<branch_id>/module-people-types", methods=["PUT"])
@require_capability("branches:write")
def set_branch_module_people_types_route(org_id, branch_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        config = db.set_branch_module_people_types(org_id, branch_id, payload)
        return _ok({"module_people_types": config})

    return _handle(_run)


@support_bp.route("/branches/<branch_id>", methods=["PATCH"])
@require_capability("branches:write")
def update_branch(branch_id):
    """Backward-compatible branch update route. Prefer org-scoped route."""
    def _run():
        payload = request.get_json(silent=True) or {}
        branch = db.update_branch(branch_id, payload)
        return _ok({"branch": branch})

    return _handle(_run)


@support_bp.route("/branches/<branch_id>/fallback", methods=["PATCH"])
@require_capability("branches:write")
def set_fallback(branch_id):
    """Manual fallback override from Node Health section."""
    def _run():
        payload = request.get_json(silent=True) or {}
        active = payload.get("fallback_active")

        if not isinstance(active, bool):
            return _err("fallback_active must be a boolean", 400)

        branch = db.set_fallback(branch_id, active)
        return _ok({"branch": branch})

    return _handle(_run)


@support_bp.route(
    "/organizations/<org_id>/branches/<branch_id>/install-token",
    methods=["POST"],
)
@require_capability("branches:write")
def create_branch_install_token(org_id, branch_id):
    """Generate a one-time Local Node install token for a branch."""
    def _run():
        payload = request.get_json(silent=True) or {}
        ttl_days = payload.get("ttl_days", 7)
        token = db.create_branch_install_token(
            org_id=org_id,
            branch_id=branch_id,
            created_by=g.support_user["id"],
            ttl_days=int(ttl_days or 7),
            created_by_actor_type="support",
        )
        return _ok({"install_token": token}, 201)

    return _handle(_run)


@support_bp.route(
    "/organizations/<org_id>/branches/<branch_id>/installer",
    methods=["POST"],
)
@require_capability("branches:write")
def download_branch_node_installer(org_id, branch_id):
    """Generate and download a branch-scoped Local Node installer ZIP."""
    def _run():
        payload = request.get_json(silent=True) or {}
        ttl_days = payload.get("ttl_days", 7)
        node_label = str(payload.get("node_label") or "").strip() or None
        use_public_ip = bool(payload.get("use_public_ip", False))
        api_base_url = str(
            payload.get("api_base_url")
            or payload.get("railway_api_base_url")
            or request.host_url.rstrip("/")
        ).strip().rstrip("/")

        token = db.create_branch_install_token(
            org_id=org_id,
            branch_id=branch_id,
            created_by=g.support_user["id"],
            ttl_days=int(ttl_days or 7),
        )

        package_type = str(payload.get("package_type") or payload.get("installer_type") or "exe").strip().lower()
        if package_type not in {"exe", "zip"}:
            return _err("package_type must be exe or zip", 400)

        # branch_name comes back on the token row; never pass the token
        # dict itself here (see installer_packager.installer_filename).
        branch_label = token.get("branch_name") if isinstance(token, dict) else None

        if package_type == "exe":
            package = build_node_installer_exe(
                project_root=Path(__file__).resolve().parent,
                install_token_payload=token,
                api_base_url=api_base_url,
                node_label=node_label,
                use_public_ip=use_public_ip,
            )
            return send_file(
                package,
                mimetype="application/vnd.microsoft.portable-executable",
                as_attachment=True,
                download_name=node_exe_installer_filename(branch_label),
            )

        package = build_node_installer_zip(
            project_root=Path(__file__).resolve().parent,
            install_token_payload=token,
            api_base_url=api_base_url,
            node_label=node_label,
            use_public_ip=use_public_ip,
        )

        return send_file(
            package,
            mimetype="application/zip",
            as_attachment=True,
            download_name=node_installer_filename(branch_label),
        )

    return _handle(_run)


# ═════════════════════════════════════════════════════════════
# MODULE ENTITLEMENTS
# ═════════════════════════════════════════════════════════════

@support_bp.route("/organizations/<org_id>/modules", methods=["GET"])
@require_capability("modules:read")
def list_modules(org_id):
    def _run():
        modules = db.list_org_modules(org_id)
        return _ok({"modules": modules})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/modules", methods=["PUT"])
@require_capability("modules:write")
def set_modules(org_id):
    """Replace the full purchased module set for an organization."""
    def _run():
        payload = request.get_json(silent=True) or {}
        module_names = payload.get("modules", [])

        if not isinstance(module_names, list):
            return _err("modules must be an array of module name strings", 400)

        modules = db.set_org_modules(org_id, module_names)
        return _ok({"modules": modules})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/modules/<module_name>", methods=["PATCH"])
@require_capability("modules:write")
def toggle_module(org_id, module_name):
    """Toggle a single module independently from billing."""
    def _run():
        payload = request.get_json(silent=True) or {}
        status = payload.get("status")

        if status not in ("active", "inactive"):
            return _err('status must be "active" or "inactive"', 400)

        module = db.toggle_module(org_id, module_name, status)
        return _ok({"module": module})

    return _handle(_run)


# ═════════════════════════════════════════════════════════════
# CLIENT INVITE
# ═════════════════════════════════════════════════════════════

@support_bp.route("/organizations/<org_id>/invite", methods=["POST"])
@require_capability("orgs:write")
def invite_client(org_id):
    """Create/reset Client Dashboard admin credentials."""
    def _run():
        payload = request.get_json(silent=True) or {}
        invite = db.create_client_invite(
            org_id=org_id,
            payload=payload,
            invited_by=g.support_user["id"],
        )
        return _ok({"invite": invite}, 201)

    return _handle(_run)


# ═════════════════════════════════════════════════════════════
# INVOICES
# ═════════════════════════════════════════════════════════════

@support_bp.route("/organizations/<org_id>/invoices", methods=["GET"])
@require_capability("invoices:read")
def list_invoices(org_id):
    def _run():
        invoices = db.list_invoices(org_id)
        return _ok({"invoices": invoices})

    return _handle(_run)


@support_bp.route("/organizations/<org_id>/invoices", methods=["POST"])
@require_capability("invoices:write")
def create_invoice(org_id):
    """Create first or renewal invoice."""
    def _run():
        payload = request.get_json(silent=True) or {}

        if not payload.get("amount") or not payload.get("due_date"):
            return _err("amount and due_date are required", 400)

        invoice = db.create_invoice(
            org_id=org_id,
            amount=float(payload["amount"]),
            due_date=payload["due_date"],
            grace_period_days=int(payload.get("grace_period_days", 7)),
            notes=payload.get("notes"),
        )
        return _ok({"invoice": invoice}, 201)

    return _handle(_run)


@support_bp.route("/invoices/<invoice_id>/mark-paid", methods=["PATCH"])
@require_capability("invoices:write")
def mark_invoice_paid(invoice_id):
    """Mark invoice paid after receiving payment."""
    def _run():
        payload = request.get_json(silent=True) or {}
        invoice = db.mark_invoice_paid(
            invoice_id=invoice_id,
            marked_by_user_id=g.support_user["id"],
            notes=payload.get("notes"),
        )
        return _ok({"invoice": invoice})

    return _handle(_run)

@support_bp.route("/invoices/<invoice_id>/message", methods=["GET"])
@require_capability("invoices:read")
def get_invoice_message(invoice_id):
    """Preview the professional invoice message before manual send."""
    def _run():
        data = build_invoice_delivery_message(
            get_supabase(),
            db.get_organization,
            invoice_id,
        )
        return _ok({"invoice_message": data})

    return _handle(_run)


@support_bp.route("/invoices/<invoice_id>/mark-sent", methods=["PATCH"])
@require_capability("invoices:write")
def mark_invoice_sent(invoice_id):
    """Track that Support copied/opened/sent the invoice manually."""
    def _run():
        payload = request.get_json(silent=True) or {}
        invoice = mark_invoice_sent_manually(
            get_supabase(),
            invoice_id,
            sent_by=g.support_user["id"],
            sent_to=payload.get("sent_to"),
            subject=payload.get("subject"),
            message=payload.get("message"),
        )
        return _ok({"invoice": invoice})

    return _handle(_run)


@support_bp.route("/invoices/<invoice_id>/pdf", methods=["GET"])
@require_capability("invoices:read")
def download_invoice_pdf(invoice_id):
    """Download professional invoice PDF generated from source-of-truth deal data."""
    def _run():
        pdf_bytes, filename = build_invoice_pdf(
            get_supabase(),
            db.get_organization,
            invoice_id,
        )
        return send_file(
            BytesIO(pdf_bytes),
            mimetype="application/pdf",
            as_attachment=True,
            download_name=filename,
        )

    return _handle(_run)


# ═════════════════════════════════════════════════════════════
# NODE HEALTH
# ═════════════════════════════════════════════════════════════

@support_bp.route("/organizations/<org_id>/node-health", methods=["GET"])
@require_capability("nodes:read")
def node_health(org_id):
    """Per-branch node status, last_seen_at, and fallback flag."""
    def _run():
        health = db.get_node_health(org_id)
        return _ok({"node_health": health})

    return _handle(_run)


# ═════════════════════════════════════════════════════════════
# GLOBAL SUPPORT PAGES — paginated, page-scoped endpoints
# ═════════════════════════════════════════════════════════════

def _support_page_request_params():
    return {
        "page": request.args.get("page", 1),
        "page_size": request.args.get("page_size") or request.args.get("pageSize") or 25,
        "search": request.args.get("search") or request.args.get("q") or "",
    }


@support_bp.route("/branches", methods=["GET"])
@require_capability("branches:read")
def global_branches_page():
    """Global branch overview. Does not load per-org detail tabs."""
    def _run():
        params = _support_page_request_params()
        page = db.list_support_branches_page(
            page=params["page"],
            page_size=params["page_size"],
            search=params["search"],
            status=request.args.get("status"),
        )
        return _ok({"branches": page.get("rows", []), "page": page})

    return _handle(_run)


@support_bp.route("/invoices", methods=["GET"])
@require_capability("invoices:read")
def global_invoices_page():
    """Global invoice center across organizations."""
    def _run():
        params = _support_page_request_params()
        page = db.list_support_invoices_page(
            page=params["page"],
            page_size=params["page_size"],
            search=params["search"],
            status=request.args.get("status"),
        )
        return _ok({"invoices": page.get("rows", []), "page": page})

    return _handle(_run)


@support_bp.route("/modules/entitlements", methods=["GET"])
@require_capability("modules:read")
def global_module_entitlements_page():
    """Global module entitlement overview across organizations."""
    def _run():
        params = _support_page_request_params()
        page = db.list_support_module_entitlements_page(
            page=params["page"],
            page_size=params["page_size"],
            search=params["search"],
            module=request.args.get("module"),
            status=request.args.get("status"),
        )
        return _ok({"entitlements": page.get("rows", []), "page": page})

    return _handle(_run)


@support_bp.route("/node-health", methods=["GET"])
@require_capability("nodes:read")
def global_node_health_page():
    """Global node health page across branch nodes."""
    def _run():
        params = _support_page_request_params()
        page = db.list_support_node_health_page(
            page=params["page"],
            page_size=params["page_size"],
            search=params["search"],
            status=request.args.get("status"),
        )
        return _ok({"node_health": page.get("rows", []), "page": page})

    return _handle(_run)


@support_bp.route("/internal-users", methods=["GET"])
@require_capability("internal_users:read")
def global_internal_users_page():
    """QIntellect internal users. Not organization scoped."""
    def _run():
        if g.support_user.get("role") != "super_admin":
            raise ValueError("Super admin access required")
        params = _support_page_request_params()
        page = db.list_internal_users_page(
            page=params["page"],
            page_size=params["page_size"],
            search=params["search"],
            role=request.args.get("role"),
            active=request.args.get("active"),
        )
        return _ok({"internal_users": page.get("rows", []), "page": page})

    return _handle(_run)


@support_bp.route("/internal-users", methods=["POST"])
@require_capability("internal_users:write")
def create_internal_user_page():
    def _run():
        if g.support_user.get("role") != "super_admin":
            raise ValueError("Super admin access required")
        payload = request.get_json(silent=True) or {}
        user = db.create_internal_user(payload, created_by=g.support_user.get("id"))
        return _ok({"internal_user": user}, 201)

    return _handle(_run)


@support_bp.route("/internal-users/<user_id>", methods=["PATCH"])
@require_capability("internal_users:write")
def update_internal_user_page(user_id):
    def _run():
        if g.support_user.get("role") != "super_admin":
            raise ValueError("Super admin access required")
        payload = request.get_json(silent=True) or {}
        user = db.update_internal_user(user_id, payload)
        return _ok({"internal_user": user})

    return _handle(_run)


@support_bp.route("/internal-users/<user_id>/reset-password", methods=["POST"])
@require_capability("internal_users:write")
def reset_internal_user_password_page(user_id):
    def _run():
        if g.support_user.get("role") != "super_admin":
            raise ValueError("Super admin access required")
        payload = request.get_json(silent=True) or {}
        user = db.reset_internal_user_password(user_id, payload.get("password"))
        return _ok({"internal_user": user})

    return _handle(_run)