// Bundled sample corpus — a fictional company knowledge base so the app
// demos instantly with zero setup. Realistic enterprise-style content.

export const SAMPLE_DOCS = [
  {
    name: 'employee-handbook.md',
    text: `# Acme Robotics Employee Handbook

## Working Hours and Flexibility
Acme Robotics operates on a hybrid schedule. Employees are expected in the office on Tuesdays, Wednesdays, and Thursdays. Mondays and Fridays are remote-optional. Core collaboration hours are 10:00 to 16:00 local time. Engineers on the robotics hardware team may require additional lab days coordinated with their team lead.

## Paid Time Off
All full-time employees receive 25 days of paid vacation per year, accrued monthly. Unused vacation rolls over up to a maximum of 10 days into the next calendar year. Sick leave is unlimited but requires a doctor's note after 5 consecutive days. Parental leave is 16 weeks fully paid for all new parents, usable within the first year.

## Expenses and Travel
Business travel must be booked through the Navan portal at least 14 days in advance for domestic trips and 21 days for international. The daily meal allowance is $75 domestic and $95 international. Economy class is standard for flights under 6 hours; premium economy is permitted for longer flights. Hotel budgets are capped at $250 per night in standard markets and $350 in high-cost cities (San Francisco, New York, London, Tokyo, Zurich).

## Equipment Policy
Every employee receives a laptop refresh every 3 years. Engineers may choose between a MacBook Pro M-series or a Lenovo ThinkPad with Linux pre-installed. A one-time home office stipend of $800 is available in the first 90 days of employment. Monitors, keyboards, and ergonomic chairs for the office are requested through the IT service desk.

## Security Requirements
All devices must run the corporate MDM profile and full-disk encryption. Two-factor authentication is mandatory for all internal systems. Credentials must never be shared, and USB storage devices are prohibited on production-network machines. Report suspected phishing to security@acmerobotics.example within 1 hour of discovery.`
  },
  {
    name: 'product-spec-atlas.md',
    text: `# Atlas Warehouse Robot — Product Specification v2.4

## Overview
Atlas is Acme Robotics' flagship autonomous mobile robot (AMR) for warehouse fulfillment. It navigates using a fusion of LiDAR, stereo vision, and UWB beacons, carrying payloads up to 450 kg at speeds up to 2.0 m/s in mixed human-robot environments.

## Navigation Stack
The navigation stack runs ROS 2 Humble on an NVIDIA Orin AGX. Global planning uses a lifelong SLAM map refreshed nightly; local planning uses a timed-elastic-band planner with dynamic obstacle prediction. Safety-rated laser scanners trigger a hardware e-stop within 80 ms if a human enters the protective field at speed.

## Battery and Charging
Atlas uses a 48V LiFePO4 pack rated for 3,000 charge cycles, providing 12 hours of continuous operation. Opportunity charging at dock stations restores 80% capacity in 45 minutes. Battery health telemetry streams to the fleet dashboard, and packs are replaced automatically when state-of-health drops below 78%.

## Fleet Management
The Horizon fleet server coordinates up to 500 robots per site. Task allocation uses a market-based bidding algorithm with congestion-aware routing. Fleet software updates roll out in waves: 5% canary, 25%, then full deployment, with automatic rollback if the error rate exceeds 0.5% over 30 minutes.

## Compliance
Atlas is certified to ISO 3691-4 and ANSI/RIA R15.08 for industrial mobile robots. The protective field configuration must be revalidated by a certified safety engineer after any change to maximum speed or payload configuration.`
  },
  {
    name: 'q3-financial-summary.md',
    text: `# Q3 FY2026 Financial Summary — Internal

## Headline Numbers
Q3 revenue reached $48.2M, up 23% year-over-year and 6% quarter-over-quarter. Gross margin improved to 52.4%, driven by manufacturing cost reductions on the Atlas line. Operating expenses were $19.8M, with R&D representing 46% of opex. Net income was $3.1M, our fourth consecutive profitable quarter.

## Segment Performance
Hardware sales contributed $31.5M (65% of revenue), led by 214 Atlas units shipped. Recurring software revenue from Horizon fleet subscriptions grew 41% YoY to $12.3M, now 25.5% of total revenue. Services and support made up the remaining $4.4M.

## Regional Breakdown
North America remains the largest market at 58% of revenue. EMEA grew fastest at 37% YoY, boosted by the new Rotterdam distribution hub. APAC held steady at 14% of revenue, with the Tokyo pilot deployment expected to convert to a full contract in Q4.

## Outlook
Q4 guidance is $52-55M revenue. Key risks: component lead times for safety-rated LiDAR units remain at 18 weeks, and the pending EU machinery regulation update may require recertification spend of approximately $400K in FY2027.`
  },
  {
    name: 'engineering-onboarding.md',
    text: `# Engineering Onboarding Guide

## Week 1: Environment Setup
Clone the monorepo from GitHub Enterprise and run the bootstrap script; it installs Bazel, the ROS 2 toolchain, and pre-commit hooks. Request access to the staging fleet simulator through the #eng-infra Slack channel. All engineers must complete security training before receiving production credentials.

## Development Workflow
We use trunk-based development with short-lived feature branches. Every PR requires one approving review and a green CI run. CI executes unit tests, integration tests against the simulator, and a lint pass. Merge queues batch compatible changes; expect 20-40 minutes from approval to merge during peak hours.

## Code Review Standards
Reviews should complete within one business day. Focus on correctness, safety implications, and test coverage — style is enforced by tooling, not humans. Any change touching the safety-rated firmware requires two reviewers from the safety-critical group and a signed hazard analysis update.

## On-Call
Engineers join the on-call rotation after 3 months. Primary on-call carries the pager for one week, with a secondary as backup. Sev-1 incidents (robot safety events or full fleet outage) page immediately and require an incident commander within 15 minutes. Postmortems are blameless and due within 5 business days.

## Testing Philosophy
Simulation-first: every navigation change must pass 500 randomized warehouse scenarios before hardware testing. Hardware test time is booked through the lab calendar; the Fremont test floor operates 06:00-22:00 weekdays.`
  },
  {
    name: 'customer-support-playbook.md',
    text: `# Customer Support Playbook — Horizon & Atlas

## Severity Definitions
Sev-1: Safety incident or entire fleet stopped. Response SLA 15 minutes, 24/7. Sev-2: Multiple robots degraded or throughput down >30%. Response SLA 1 hour during business hours, 4 hours off-hours. Sev-3: Single robot issue with workaround. Response SLA 8 business hours. Sev-4: Questions and feature requests. Response SLA 2 business days.

## Escalation Path
Tier 1 support handles triage and known-issue resolution using the runbook library. Tier 2 (fleet engineers) can access customer telemetry with written customer consent logged in the ticket. Tier 3 escalations page the on-call product engineer. Safety incidents always bypass tiers and go directly to the safety response team plus the VP of Engineering.

## Common Issues
Localization drift after warehouse layout changes: trigger a remap via Horizon admin console; robots resume within 20 minutes. Charging dock misalignment: run the dock calibration wizard; if failure persists, dispatch field service. UWB beacon battery low: beacons report at 20% remaining and must be replaced within 2 weeks to avoid degraded positioning.

## Customer Communication
Status updates every 30 minutes during Sev-1, hourly during Sev-2. Never share internal speculation about root cause; share confirmed findings only. All Sev-1 and Sev-2 incidents receive a written RCA within 7 days, reviewed by support leadership before sending.`
  }
];
