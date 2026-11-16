import { expect, goTab, openDemo, openUserSection, test } from './fixtures';

// Lo que destapó una prueba con personas que no conocían la app (alguien con obesidad y alguien muy en forma): se escribe como se habla
// («1,62 m», «118 kg», «30 min», «2,5 km»), el sexo no se da por supuesto y no se aceptan distancias imposibles.

test('un perfil nuevo no trae el sexo elegido, y se entiende «1,62 m» y «118 kg»', async ({ page }) => {
  await page.goto('/');
  const data = await openUserSection(page, 'Mis datos');
  await data.getByRole('button', { name: 'Introducir mis datos' }).click();
  const form = page.getByRole('dialog', { name: 'Actualizar mis datos' });
  await form.getByLabel('Altura (cm)').fill('1,62 m');
  await form.getByLabel('Peso (kg)').fill('118 kg');
  await form.getByLabel('Fecha de nacimiento').fill('1982-03-14');

  // Ni «Hombre» ni «Mujer» están elegidos: guardar sin elegir avisa en vez de guardar un sexo por defecto.
  await expect(form.getByRole('button', { name: 'Hombre' })).toHaveAttribute('aria-pressed', 'false');
  await expect(form.getByRole('button', { name: 'Mujer' })).toHaveAttribute('aria-pressed', 'false');
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(form.getByRole('alert')).toContainText('Indica el sexo');
  await expect(form.getByRole('alert')).not.toContainText('altura');
  await expect(form.getByRole('alert')).not.toContainText('peso');

  await form.getByRole('button', { name: 'Mujer' }).click();
  await form.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Datos guardados' })).toBeVisible();

  // Se guardó 162 cm y 118 kg, y se enseñan sin el «,0» de sobra (el apartado «Mis datos» sigue abierto debajo).
  await expect(data).toContainText('162 cm');
  await expect(data).toContainText('118 kg');
  await expect(data).toContainText('Mujer');
  await expect(data).not.toContainText(',0 cm');
  await expect(data).not.toContainText(',0 kg');
});

test('un entreno a mano acepta unidades escritas y rechaza lo imposible, diciendo por qué', async ({ page }) => {
  await openDemo(page);
  await goTab(page, 'Deportes');
  await page.getByRole('button', { name: 'Añadir' }).click();
  const sheet = page.getByRole('dialog', { name: 'Añadir entrenamiento' });
  await sheet.getByLabel('Actividad').selectOption('walk');

  // 1,5 minutos no es una duración (se guardaba como 2 en silencio): se pide en minutos enteros.
  await sheet.getByLabel('Duración (minutos)').fill('1,5');
  await sheet.getByRole('button', { name: 'Guardar entrenamiento' }).click();
  await expect(sheet.getByRole('alert')).toContainText('minutos enteros');

  // 500 km andando en media hora: un error al escribir. Se explica con la velocidad que saldría.
  await sheet.getByLabel('Duración (minutos)').fill('30 min');
  await sheet.getByLabel('Distancia (km)').fill('500');
  await sheet.getByRole('button', { name: 'Guardar entrenamiento' }).click();
  await expect(sheet.getByRole('alert')).toContainText('km/h de media');
  await expect(sheet).toBeVisible();

  // Con una distancia posible y con su unidad, se guarda.
  await sheet.getByLabel('Distancia (km)').fill('2,5 km');
  await sheet.getByRole('button', { name: 'Guardar entrenamiento' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entrenamiento guardado' })).toBeVisible();
  await expect(sheet).toBeHidden();
});
