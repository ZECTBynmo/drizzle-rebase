CREATE OR REPLACE FUNCTION is_org_member(_user uuid, _org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM organization_members
    WHERE user_id = _user AND organization_id = _org
  );
$$;
