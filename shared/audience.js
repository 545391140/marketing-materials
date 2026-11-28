export const ALL = "全部";
export const roles = ["partner", "sales", "editor", "reviewer"];
export const values = (value) => Array.isArray(value) ? value : [value];
export const countriesOf = (rule) => rule.country === undefined ? ALL : rule.country;
const match = (scope, value) => scope === ALL || values(scope).includes(value);
const roleMatches = (scope, role) =>
  scope === ALL || scope === role ||
  (scope === "伙伴" && role === "partner") ||
  (scope === "员工" && role !== "partner");

export function allowed(user, rules) {
  return (rules || []).some((rule) => roleMatches(rule.role, user.role) &&
    user.grants.some((grant) => grant && grant.active !== false &&
      match(rule.bg, grant.bg) && match(rule.region, grant.region) &&
      match(rule.job || ALL, grant.job || user.job) &&
      match(rule.companyId || ALL, grant.companyId) && match(countriesOf(rule), grant.country) && match(rule.channel, grant.channel)));
}

// Check the union one role/country/type combination at a time. A wildcard
// requires a wildcard in the covering rule, including for future dictionary values.
export function subset(inner, outer) {
  return inner.every((rule) => {
    const candidates = outer.filter((other) =>
      match(other.bg, rule.bg) && match(other.region, rule.region) &&
      match(other.job || ALL, rule.job || ALL) && match(other.companyId || ALL, rule.companyId || ALL));
    return roles.filter((role) => roleMatches(rule.role, role)).every((role) => {
      const byRole = candidates.filter((other) => roleMatches(other.role, role));
      return values(countriesOf(rule)).every((country) => {
        const byCountry = byRole.filter((other) => match(countriesOf(other), country));
        return values(rule.channel).every((channel) =>
          byCountry.some((other) => match(other.channel, channel)));
      });
    });
  });
}
