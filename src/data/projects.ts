export type Project = {
  name: string;
  description: string;
  tags: string[];
  href?: string;
};

export const projects: Project[] = [
  {
    name: 'CanvasPilot',
    description: 'AI-powered canvas automation and visual workflow tool.',
    tags: ['React', 'FastAPI', 'PostgreSQL', 'AWS', 'Docker'],
    href: 'https://github.com/Gall-ardo/CanvasPilot',
  },
  {
    name: 'Jobsy',
    description: 'Job application and automation platform.',
    tags: ['Python', 'TypeScript', 'React', 'Docker'],
    href: 'https://github.com/Gall-ardo/Jobsy',
  },
  {
    name: 'ProctorHub',
    description: 'Exam monitoring and proctoring-related system.',
    tags: ['React.js', 'Node.js', 'Express', 'MySQL'],
    href: 'https://github.com/Gall-ardo/ProctorHub',
  },
  {
    name: 'Offerings Scraper',
    description: 'Course offering scraper and monitoring tool.',
    tags: ['Python', 'Flask', 'Selenium', 'AWS'],
    href: 'https://github.com/Gall-ardo/Offerings-Scraper',
  },
  {
    name: 'Bilkent Connect',
    description: 'University/community-related platform.',
    tags: ['Java', 'Android', 'Firebase', 'Jsoup'],
    href: 'https://github.com/Gall-ardo/Bilkent-Connect',
  },
  {
    name: 'UART Project',
    description: 'Embedded/systems communication project.',
    tags: ['SystemVerilog', 'FPGA'],
    href: 'https://github.com/Gall-ardo/UART-Design-SystemVerilog',
  },
];
