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
    tags: ['AI tools', 'automation', 'web'],
  },
  {
    name: 'Jobsy',
    description: 'Job application and automation platform.',
    tags: ['automation', 'full-stack', 'productivity'],
  },
  {
    name: 'ProctorHub',
    description: 'Exam monitoring and proctoring-related system.',
    tags: ['computer vision', 'web', 'monitoring'],
  },
  {
    name: 'Offerings Scraper',
    description: 'Course offering scraper and monitoring tool.',
    tags: ['scraping', 'automation', 'data'],
  },
  {
    name: 'Bilkent Connect',
    description: 'University/community-related platform.',
    tags: ['community', 'web', 'university'],
  },
  {
    name: 'UART Project',
    description: 'Embedded/systems communication project.',
    tags: ['embedded systems', 'UART', 'low-level'],
  },
];
