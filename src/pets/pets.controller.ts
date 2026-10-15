import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ParseBigIntIdPipe } from '../common/pipes/parse-bigint-id.pipe';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreatePetDto } from './dto/create-pet.dto';
import { UpdatePetDto } from './dto/update-pet.dto';
import { PetsService } from './pets.service';

@ApiTags('Pets')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CUSTOMER')
@Controller('pets')
export class PetsController {
  constructor(private readonly petsService: PetsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a pet profile',
    description:
      'Creates a pet profile owned by the currently authenticated customer.',
  })
  @ApiCreatedResponse({
    description: 'Pet profile created successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Request validation failed.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description: 'Only customers can manage pet profiles.',
  })
  @ApiNotFoundResponse({
    description: 'Pet type was not found.',
  })
  createPet(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createPetDto: CreatePetDto,
  ) {
    return this.petsService.createPet(user, createPetDto);
  }

  @Get()
  @ApiOperation({
    summary: 'Get my pets',
    description:
      'Returns all active pet profiles owned by the currently authenticated customer.',
  })
  @ApiOkResponse({
    description: 'Pet profiles returned successfully.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description: 'Only customers can manage pet profiles.',
  })
  getMyPets(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.petsService.getMyPets(user);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one of my pets',
    description:
      'Returns an active pet profile only if it belongs to the currently authenticated customer.',
  })
  @ApiOkResponse({
    description: 'Pet profile returned successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Pet ID is not a valid positive integer.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The authenticated customer does not own this pet.',
  })
  @ApiNotFoundResponse({
    description: 'Pet was not found.',
  })
  getMyPetById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) petId: string,
  ) {
    return this.petsService.getMyPetById(
      user,
      petId,
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update one of my pets',
    description:
      'Updates an active pet profile only if it belongs to the currently authenticated customer.',
  })
  @ApiOkResponse({
    description: 'Pet profile updated successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Request validation failed.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The authenticated customer does not own this pet.',
  })
  @ApiNotFoundResponse({
    description: 'Pet or pet type was not found.',
  })
  updateMyPet(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) petId: string,
    @Body() updatePetDto: UpdatePetDto,
  ) {
    return this.petsService.updateMyPet(
      user,
      petId,
      updatePetDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deactivate one of my pets',
    description:
      'Soft-deletes the pet by changing its status to INACTIVE.',
  })
  @ApiNoContentResponse({
    description: 'Pet profile deactivated successfully.',
  })
  @ApiBadRequestResponse({
    description: 'Pet ID is not a valid positive integer.',
  })
  @ApiUnauthorizedResponse({
    description: 'Authentication is required.',
  })
  @ApiForbiddenResponse({
    description:
      'The authenticated customer does not own this pet.',
  })
  @ApiNotFoundResponse({
    description: 'Pet was not found.',
  })
  async deleteMyPet(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseBigIntIdPipe) petId: string,
  ): Promise<void> {
    await this.petsService.deleteMyPet(
      user,
      petId,
    );
  }
}