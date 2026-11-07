# companion-module-stagetec-xci

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE)

## Version History

### Version 2.0.1

- Fix: Disable expressions for `all` option
- Fix: typos
- Fix: Remove some dead code
- Fix: Better status updates

### Version 2.0.0

- Requires Companion 5.1 or later
- Rewritten in TypeScript, on version 2.2 of the Companion module API, running on Node 26
- Read the state of every logic cell on start and on a config change. New SNMP Version and SNMP Agent Port settings
- Read the Nexus status from the XCI's MIB: project, base device health, sync source, trap destinations and errors, as variables, value feedbacks and a sync source feedback. New Status Poll Interval setting and Refresh action
- Keep errors up to date from the XCI's error traps, in v1 and v2c
- Base Device Health preset, for each base device the XCI reports
- The Logic Cell field takes an expression in place of the Use Variable option. Existing buttons are upgraded
- Fix: Reset Count reset the count, but set the latch variable rather than the count variable
- Fix: latched feedbacks were not cleared by a config change
- Fix: a config change while the listener was binding, or after it failed to bind, threw
- A trap rechecks only the feedbacks on the cells it reports

### Version 1.3.0

- Pass Shared UDP Socket to SNMP agent so multiple instances can be run at once
- Let Companion parse variables
- Abort actions and feedbacks by throwing errors
- Replace isVisible properties with isVisibleExpression
- Update dependencies

### Version 1.2.2

- Parse local variables

### Version 1.2.1

- Use Node 22
- Update dependencies

### Version 1.2.0

- Add count variable and reset action
- Update dependencies

### Version 1.1.3

- Update dependencies

### Version 1.1.1

- Add latching feedbacks to complement variables
- Update status on absent XCI IP

### Version 1.1.0

- Accept variables for feedback cell input
- Add 'most recent' variable, displays the cell number of most recently received positive going trap
- Add cell latch variable, and reset action. Goes true when triggered by an SNMP trap, and stays that way until reset
- Update companion-module-base to 1.8.0
- Update net-snmp to 3.11.2

### Version 1.0.2

- Initial release
