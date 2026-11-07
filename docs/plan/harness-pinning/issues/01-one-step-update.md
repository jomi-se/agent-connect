# 01 One step that finds and bumps new harness releases

Status: needs-triage

One command, or a scheduled job that opens a pull request, which:

- finds new releases of the four harnesses the box installs;
- bumps the pins;
- says what changed upstream for each one (release notes or changelog, with a
  link), so a reviewer can tell a patch from a behaviour change at a glance.

Open: a local command, a scheduled bot pull request, or both. The project
commits on main, so a bot pull request needs a cheap path to main.
