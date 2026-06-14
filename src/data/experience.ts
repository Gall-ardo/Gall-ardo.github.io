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
      'Training Sparse Autoencoders on unified vision-language models to extract human-interpretable features and probe semantic alignment between multi-modal understanding and diffusion-based generation.',
  },
  {
    org: 'KUIS AI Center',
    role: 'Deep Learning Research Intern',
    period: 'May 2025 – Present',
    advisor: 'Prof. Aykut Erdem, Prof. Erkut Erdem',
    description:
      'Developing a diffusion-based framework for 360° panoramic video generation, focusing on realistic motion and spatial continuity, and leading evaluation against prior methods.',
  },
  {
    org: 'HUCVL — Hacettepe University',
    role: 'Deep Learning Research Intern',
    period: 'July 2024 – Present',
    advisor: 'Prof. Aykut Erdem, Prof. Erkut Erdem',
    description:
      'Researching low-light image enhancement with diffusion-based generative models. Built a synthetic data pipeline for varying illumination and noise conditions; exploring physics-guided priors for perceptual quality.',
  },
  {
    org: 'DLR Lab — Bilkent University',
    role: 'Undergraduate Researcher',
    period: 'September 2024 – March 2025',
    advisor: 'Asst. Prof. Ayşegül Dündar',
    description:
      'Worked on text-to-video generation with diffusion models, developing a SAM2-based segmentation pipeline with morphological operations to improve temporal coherence.',
  },
  {
    org: 'Ekinsoft',
    role: 'Computer Vision Intern',
    period: 'June 2025 – July 2025',
    description:
      'Optimized CNN and ViT-based object detection on large-scale license plate data and Dockerized end-to-end training and inference pipelines for GPU and edge deployment.',
  },
  {
    org: 'Bilkent University',
    role: 'Lab Tutor',
    period: 'October 2023 – May 2024',
    description:
      'Led lab sections for CS115 (Python) and CS101 (Java), covering algorithms, data structures, and object-oriented programming.',
  },
];
