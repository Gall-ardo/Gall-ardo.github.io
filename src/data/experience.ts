export type Experience = {
  org: string;
  role: string;
  period: string;
  advisor?: string;
  description: string;
};

export const experience: Experience[] = [
  {
    org: 'EML Group — TUM & Helmholtz',
    role: 'Research Intern',
    period: 'February 2026 – Present',
    advisor: 'Prof. Zeynep Akata',
    description:
      'Working on mechanistic interpretability for unified vision-language models using Sparse Autoencoders.',
  },
  {
    org: 'KUIS AI Center & HUCVL',
    role: 'Deep Learning Research Intern',
    period: 'July 2024 – Present',
    advisor: 'Prof. Aykut Erdem, Prof. Erkut Erdem',
    description:
      'Researching low-light image enhancement and diffusion-based 360° panoramic video generation.',
  },
  {
    org: 'DLR Lab — Bilkent University',
    role: 'Undergraduate Researcher',
    period: 'September 2024 – March 2025',
    advisor: 'Asst. Prof. Ayşegül Dündar',
    description:
      'Worked on text-to-video generation and temporal coherence using diffusion models.',
  },
  {
    org: 'Ekinsoft',
    role: 'Computer Vision Intern',
    period: 'June 2025 – July 2025',
    description:
      'Optimized object detection models and Dockerized training/inference pipelines.',
  },
  {
    org: 'Bilkent University',
    role: 'Lab Tutor',
    period: 'October 2023 – May 2024',
    description:
      'Guided students in Python, Java, data structures, and object-oriented programming.',
  },
];
